// Copyright (C) 2012,2013 Colin Walters <walters@verbum.org>
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
const DynTask = imports.dyntask;
const JsonDB = imports.jsondb;
const ProcUtil = imports.procutil;
const JsonUtil = imports.jsonutil;
const Snapshot = imports.snapshot;
const Config = imports.config;
const BuildUtil = imports.buildutil;
const Vcs = imports.vcs;
const ArgParse = imports.argparse;

const Make = new Lang.Class({
    Name: 'Make',
    Extends: Builtin.Builtin,

    DESCRIPTION: "Execute tasks",

    _init: function() {
	this.parent();
	this.parser.addArgument('tasknames', { nargs: '*' });
    },

    execute: function(args, loop, cancellable) {
	this._loop = loop;
	this._err = null;
	let taskmaster = new DynTask.TaskMaster(this.workdir.get_child('tasks'),
						{ onEmpty: Lang.bind(this, this._onTasksComplete) });
	taskmaster.pushTasks(args.tasknames);
	loop.run();
	if (this._err)
	    throw new Error("Error: " + this._err);
	else
	    print("Success!")
    },

    _onTasksComplete: function(success, err) {
	if (!success)
	    this._err = err;
	this._loop.quit();
    }
});
