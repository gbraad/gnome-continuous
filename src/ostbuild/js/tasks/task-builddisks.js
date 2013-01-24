// -*- indent-tabs-mode: nil; tab-width: 2; -*-
// Copyright (C) 2013 Colin Walters <walters@verbum.org>
//
// This library is free software; you can redistribute it and/or
// modify it under the terms of the GNU Lesser General Public
// License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.
//
// This library is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Lesser General Public License for more details.
//
// You should have received a copy of the GNU Lesser General Public
// License along with this library; if not, write to the
// Free Software Foundation, Inc., 59 Temple Place - Suite 330,
// Boston, MA 02111-1307, USA.

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Format = imports.format;

const GSystem = imports.gi.GSystem;

const Builtin = imports.builtin;
const ArgParse = imports.argparse;
const Task = imports.task;
const ProcUtil = imports.procutil;
const LibQA = imports.libqa;
const JsonDB = imports.jsondb;
const Config = imports.config;
const JsonUtil = imports.jsonutil;
const GuestFish = imports.guestfish;

const TaskBuildDisks = new Lang.Class({
    Name: 'TaskBuildDisks',
    Extends: Task.TaskDef,

    TaskPattern: [/builddisks\/(.*?)$/, 'prefix'],

    execute: function(cancellable) {
        this.prefix = this.vars['prefix'];

        this.subworkdir = Gio.File.new_for_path('.');

	      this.imageDir = this.workdir.get_child('images').get_child(this.prefix);
	      this.currentImageLink = this.imageDir.get_child('current');
	      this.previousImageLink = this.imageDir.get_child('previous');
        GSystem.file_ensure_directory(this.imageDir, true, cancellable);

	      let builddb = this._getResultDb('build/' + this.prefix);

        let latestPath = builddb.getLatestPath();
        let buildVersion = builddb.parseVersionStr(latestPath.get_basename());
        this._buildData = builddb.loadFromPath(latestPath, cancellable);

        let targetImageDir = this.imageDir.get_child(buildVersion);

        if (targetImageDir.query_exists(null)) {
            print("Already created " + targetImageDir.get_path());
            return;
        }

        let newImageDir = this.subworkdir.get_child('images');
        GSystem.file_ensure_directory(newImageDir, true, cancellable);

	      let targets = this._buildData['targets'];

	      // Special case the default target - we do a pull, then clone
	      // that disk for further tests.  This is a speedup under the
	      // assumption that the trees are relatively close, so we avoid
	      // copying data via libguestfs repeatedly.
	      let defaultTarget = this._buildData['snapshot']['default-target'];
        let defaultRevision = this._buildData['targets'][defaultTarget];
        let defaultTargetDiskName = this._diskNameForTarget(defaultTarget);

        let currentDefaultDiskPath = this.currentImageLink.get_child(defaultTargetDiskName);

        let tmpDefaultDiskPath = newImageDir.get_child(defaultTargetDiskName);
        GSystem.shutil_rm_rf(tmpDefaultDiskPath, cancellable);

	      if (!currentDefaultDiskPath.query_exists(null)) {
            LibQA.createDisk(tmpDefaultDiskPath, cancellable);
	      } else {
            LibQA.copyDisk(currentDefaultDiskPath, tmpDefaultDiskPath, cancellable);
        }

        let osname = this._buildData['snapshot']['osname'];

	      ProcUtil.runSync(['ostbuild', 'qa-pull-deploy', tmpDefaultDiskPath.get_path(),
			                    this.repo.get_path(), osname, defaultTarget, defaultRevision],
			                   cancellable, { logInitiation: true });
        
        for (let targetName in targets) {
	          if (targetName == defaultTarget)
		            continue;
            let targetRevision = this._buildData['targets'][targetName];
	          let diskName = this._diskNameForTarget(targetName, true);
            let tmppath = newImageDir.get_child(diskName);
            GSystem.shutil_rm_rf(tmppath, cancellable);
	          LibQA.createDiskSnapshot(tmpDefaultDiskPath, tmppath, cancellable);
	          ProcUtil.runSync(['ostbuild', 'qa-pull-deploy', tmppath.get_path(), 
			                        this.repo.get_path(), osname, targetName, targetRevision],
			                       cancellable, { logInitiation: true });
	      }

        GSystem.file_rename(newImageDir, this.imageDir.get_child(newImageDir.get_basename()),
                            cancellable);

        let tmpLinkPath = Gio.File.new_for_path(this.imageDir, 'current-new.tmp');
        GSystem.shutil_rm_rf(tmpLinkPath, cancellable);
        tmpLinkPath.make_symbolic_link(newImageDir.get_basename(), cancellable);
        let currentInfo = currentImageLink.query_info('standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
        let newPreviousTmppath = this.imageDir.get_child('previous-new.tmp');
        GSystem.shutil_rm_rf(newPreviousTmppath, cancellable);
        let currentLinkTarget = currentInfo.get_symlink_target();
        newPreviousTmppath.make_symbolic_link(currentLinkTarget, cancellable);
        GSystem.file_rename(newPreviousTmppath, previousImageLink);
        GSystem.file_rename(tmpLinkPath, currentImageLink);
    },

    _diskNameForTarget: function(targetName, isSnap) {
	      let squashedName = targetName.replace(/\//g, '_');
	      let suffix;
	      if (isSnap) {
	          suffix = '-snap.qcow2';
	      } else {
	          suffix = '-disk.qcow2';
        }
	      return this.prefix + '-' + squashedName + suffix;
    }
});
