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

const ArgParse = imports.argparse;
const ProcUtil = imports.procutil;

const loop = GLib.MainLoop.new(null, true);

const QaPullDeploy = new Lang.Class({
    Name: 'QaPullDeploy',

    _findCurrentKernel: function(mntdir, cancellable) {
        let deployBootdir = mntdir.resolve_relative_path('ostree/current/boot');
        let d = deployBootdir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
	      let finfo;
	      while ((finfo = d.next_file(cancellable)) != null) {
	          let child = d.get_child(finfo.get_name());
	          if (child.get_basename().indexOf('vmlinuz-') == 0) {
                return child;
            }
        }
        d.close();
        throw new Error("Couldn't find vmlinuz- in " + deployBootdir.get_path());
    },

    _parseKernelRelease: function(kernelPath) {
        let name = kernelPath.get_basename();
        let idx = name.indexOf('-');
        if (idx == -1) throw new Error("Invalid kernel name " + kernelPath.get_path());
        let kernelRelease = name.substr(idx + 1);
        return kernelRelease;
    },

    _getInitramfsPath: function(mntdir, kernelRelease) {
        let bootdir = mntdir.get_child('boot');
        let initramfsName = 'initramfs-' + kernelRelease + '.img';
        let path = bootdir.resolve_relative_path('ostree/' + initramfsName);
        if (!path.query_exists(null))
            throw new Error("Couldn't find initramfs " + path.get_path());
        return path;
    },

    execute: function(argv) {
        let cancellable = null;
        let parser = new ArgParse.ArgumentParser("Generate a disk image");
        parser.addArgument('diskpath');
        parser.addArgument('srcrepo');
        parser.addArgument('osname');
        parser.addArgument('target');
        
        let args = parser.parse(argv);

        let diskpath = Gio.File.new_for_path(args.diskpath);

        let workdir = Gio.File.new_for_path('.');
        let mntdir = workdir.get_child('mnt');
        GSystem.file_ensure_directory(mntdir, true, cancellable);
        let ostreedir = mntdir.get_child('ostree');
        let guestmountPidFile = workdir.get_child('guestmount.pid');

        if (guestmountPidFile.query_exists(null)) {
            throw new Error("guestmount pid file exists (unclean shutdown?): " + guestmountPidFile.get_path());
        }

        try {
            let procContext = new GSystem.SubprocessContext({ argv: ['guestmount', '--rw', '-o', 'allow_root',
                                                                     '--pid-file', guestmountPidFile.get_path(),
                                                                     '-a', diskpath.get_path(),
                                                                     '-m', '/dev/sda3',
                                                                     '-m', '/dev/sda1:/boot',
                                                                     mntdir.get_path()] });
            let guestfishProc = new GSystem.Subprocess({context: procContext});
            print("starting guestfish");
            guestfishProc.init(cancellable);
            guestfishProc.wait_sync_check(cancellable);
            // guestfish should have daemonized now (unfortunately, if
            // there was a way to avoid that we would).
            
            let adminCmd = ['ostree', 'admin', '--ostree-dir=' + ostreedir.get_path(),
                            '--boot-dir=' + mntdir.get_child('boot').get_path()];
            let adminEnv = GLib.get_environ();
            adminEnv.push('LIBGSYSTEM_ENABLE_GUESTFS_FUSE_WORKAROUND=1');
            ProcUtil.runSync(adminCmd.concat(['os-init', args.osname]), cancellable,
                             {logInitiation: true, env: adminEnv});
            ProcUtil.runSync(['ostree', '--repo=' + ostreedir.get_child('repo').get_path(),
                              'pull-local', args.srcrepo, args.target], cancellable,
                             {logInitiation: true, env: adminEnv});
            ProcUtil.runSync(adminCmd.concat(['deploy', args.osname, args.target]), cancellable,
                             {logInitiation: true, env: adminEnv});
            ProcUtil.runSync(adminCmd.concat(['prune', args.osname]), cancellable,
                             {logInitiation: true, env: adminEnv});

            let kernelPath = this._findCurrentKernel(mntdir, cancellable);
            let kernelRelease = this._parseKernelRelease(kernelPath);
            let initramfsPath = this._getInitramfsPath(mntdir, kernelRelease);

            let defaultFstab = 'LABEL=gnome-ostree-root / ext4 defaults 1 1\n\
LABEL=gnome-ostree-boot /boot ext4 defaults 1 2\n\
LABEL=gnome-ostree-swap swap swap defaults 0 0\n';
            let fstabPath = ostreedir.resolve_relative_path('deploy/gnome-ostree/current-etc/fstab'); 
            fstabPath.replace_contents(defaultFstab, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
            
            let grubDir = mntdir.resolve_relative_path('boot/grub');
            GSystem.file_ensure_directory(grubDir, false, cancellable);
            let bootRelativeKernelPath = bootdir.get_relative_path(kernelPath);
            let bootRelativeInitramfsPath = bootdir.get_relative_path(initramfsPath);
            let grubConfPath = grubDir.get_child('grub.conf');
            let grubConf = Format.vprintf('default=0\n\
timeout=5\n\
title GNOME-OSTree\n\
        root (hd0,0)\n\
        kernel %s root=LABEL=gnome-ostree-root\n\
        initrd %s\n', [bootRelativeKernelPath, bootRelativeInitramfsPath]);
            grubConf.replace_contents(grubConf, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
        } finally {
            if (guestmountPidFile.query_exists(null)) {
                let pidStr = GSystem.file_load_contents_utf8(guestmountPidFile, cancellable);
                if (pidStr.length > 0) {
                    ProcUtil.runSync(['fusermount', '-u', mntdir.get_path()], cancellable,
                                     {logInitiation: true});
                    let pid = parseInt(pidStr);
                    for (let i = 0; i < 30; i++) {
                        let killContext = new GSystem.SubprocessContext({argv: ['kill', '-0', ''+pid]});
                        killContext.set_stderr_disposition(GSystem.SubprocessStreamDisposition.NULL);
                        let killProc = new GSystem.Subprocess({context: killContext});
                        killProc.init(null);
                        let [waitSuccess, ecode] = killProc.wait_sync(null);
                        let [killSuccess, statusStr] = ProcUtil.getExitStatusAndString(ecode);
                        if (killSuccess) {
                            print("Awaiting termination of guestfish, pid=" + pid + " timeout=" + (30 - i) + "s");
                            GLib.usleep(GLib.USEC_PER_SEC);
                        } else {
                            print("Complete!");
                            break;
                        }
                    }
                }
            }
        }
    }
});

function main(argv) {
    let ecode = 1;
    var app = new QaPullDeploy();
    GLib.idle_add(GLib.PRIORITY_DEFAULT,
                  function() { try { app.execute(argv); ecode = 0; } finally { loop.quit(); }; return false; });
    loop.run();
    return ecode;
}
