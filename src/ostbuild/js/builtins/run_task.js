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

const RunTask = new Lang.Class({
    Name: 'RunTask',
    Extends: Builtin.Builtin,

    DESCRIPTION: "Internal helper to execute a task",

    _init: function() {
	this.parent();
	this.parser.addArgument('taskName');
	this.parser.addArgument('outfd');
    },

    execute: function(args, loop, cancellable) {
	let outstream = Gio.UnixOutputStream.new(parseInt(args.outfd), true);
	let taskset = DynTask.TaskSet.prototype.getInstance();
	let [taskDef, inputs] = taskset.getTask(args.taskName);
	let instance = new taskDef(null, args.taskName, inputs);
	let result = instance.executeSync(cancellable);
	JsonUtil.writeJsonToStream(outstream, result || {}, cancellable);
	outstream.close(cancellable);
    }
});
