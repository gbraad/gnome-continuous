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
const format = imports.format;
const Lang = imports.lang;

const GSystem = imports.gi.GSystem;
const Params = imports.params;
const JsonUtil = imports.jsonutil;
const ProcUtil = imports.procutil;
const BuildUtil = imports.buildutil;

const VERSION_RE = /(\d+)\.(\d+)/;

var _tasksetInstance = null;
const TaskSet = new Lang.Class({
    Name: 'TaskSet',
    
    _init: function() {
	this._tasks = [];
	let taskdir = Gio.File.new_for_path(GLib.getenv('OSTBUILD_DATADIR')).resolve_relative_path('js/tasks');
	let denum = taskdir.enumerate_children('standard::*', 0, null);
	let finfo;
	
	for (let taskname in imports.tasks) {
	    let taskMod = imports.tasks[taskname];
	    for (let defname in taskMod) {
		if (defname.indexOf('Task') !== 0)
		    continue;
		let cls = taskMod[defname];
		this.register(cls);
	    }
	}
    },

    register: function(taskdef) {
	this._tasks.push(taskdef);
    },

    getAllTasks: function() {
	return this._tasks;
    },

    getTask: function(taskName, params) {
	params = Params.parse(params, { allowNone: false })
	for (let i = 0; i < this._tasks.length; i++) {
	    let taskDef = this._tasks[i];
	    let pattern = taskDef.prototype.TaskPattern;
	    let re = pattern[0];
	    let match = re.exec(taskName);
	    if (!match)
		continue;
	    let vars = {};
	    for (let i = 1; i < pattern.length; i++) {
		vars[pattern[i]] = match[i];
	    }
	    return [taskDef, vars];
	}
	if (!params.allowNone)
	    throw new Error("No task definition matches " + taskName);
	return null;
    },

    getInstance: function() {
	if (!_tasksetInstance)
	    _tasksetInstance = new TaskSet();
	return _tasksetInstance;
    }
});
    
const TaskMaster = new Lang.Class({
    Name: 'TaskMaster',

    _init: function(path, params) {
	params = Params.parse(params, {maxConcurrent: 4,
				       onEmpty: null});
	this.path = path;
	this.maxConcurrent = params.maxConcurrent;
	this._onEmpty = params.onEmpty;
	this.cancellable = null;
	this._idleRecalculateId = 0;
	this._executing = [];
	this._pendingTasksList = [];
	this._seenTasks = {};
	this._completeTasks = {};
	this._taskErrors = {};
	this._caughtError = false;

	this._taskset = TaskSet.prototype.getInstance();
    },

    _pushRecurse: function(taskName, seen) {
	if (seen[taskName])
	    return null;
	let [taskDef, inputs] = this._taskset.getTask(taskName);
	let specifiedDependencies = taskDef.prototype.getDepends(inputs);
	let waitingDependencies = {};
	for (let j = 0; j < specifiedDependencies.length; j++) {
	    let depName = specifiedDependencies[j];
	    if (!this._completeTasks[depName]) {
		let depTask = this._pushRecurse(depName, seen);
		waitingDependencies[depName] = depTask;
	    }
	}
	let instance = new taskDef(this, taskName, inputs);
	instance.onComplete = Lang.bind(this, this._onComplete, instance);
	instance.dependencies = specifiedDependencies;
	instance.waitingDependencies = waitingDependencies;
	this._pendingTasksList.push(instance);
	seen[taskName] = true;
	this._queueRecalculate();
	return instance;
    },

    pushTasks: function(taskNames) {
	let seen = {};
	for (let i = 0; i < taskNames.length; i++)
	    this._pushRecurse(taskNames[i], seen);
    },

    _queueRecalculate: function() {
	if (this._idleRecalculateId > 0)
	    return;
	this._idleRecalculateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, Lang.bind(this, this._recalculate));
    },

    _visit: function(task, sorted, scanned) {
	if (scanned[task.name])
	    return;
	scanned[task.name] = true;
	for (let depName in task.waitingDependencies) {
	    let dep = task.waitingDependencies[depName];
	    this._visit(dep, sorted, scanned);
	}
	sorted.push(task);
    },

    _recalculate: function() {
	let sorted = [];
	let scanned = {};

	this._idleRecalculateId = 0;

	if (this._executing.length == 0 &&
	    this._pendingTasksList.length == 0) {
	    this._onEmpty(true, null);
	    return;
	} else if (this._pendingTasksList.length == 0) {
	    return;
	}

	for (let i = 0; i < this._pendingTasksList.length; i++) {
	    let task = this._pendingTasksList[i];
	    this._visit(task, sorted, scanned);
	}

	this._pendingTasksList = sorted;

	this._reschedule();
    },

    _onComplete: function(result, error, task) {
	if (error) {
	    print("TaskMaster: While executing " + task.name + ": " + error);
	    if (!this._caughtError) {
		this._caughtError = true;
		this._onEmpty(false, error);
	    }
	    return;
	} else {
	    print("TaskMaster: Completed: " + task.name + " : " + JSON.stringify(result));
	}
	let idx = -1;
	for (let i = 0; i < this._executing.length; i++) {
	    let executingTask = this._executing[i];
	    if (executingTask !== task)
		continue;
	    idx = i;
	    break;
	}
	if (idx == -1)
	    throw new Error("TaskMaster: Internal error - Failed to find completed task:" + task.name);
	task.result = result;
	this._completeTasks[task.name] = task;
	this._executing.splice(idx, 1);
	for (let i = 0; i < this._pendingTasksList.length; i++) {
	    let pendingTask = this._pendingTasksList[i];
	    let deps = pendingTask.waitingDependencies;
	    if (deps[task.name]) {
		print("Completed dep + " + task.name);
		delete deps[task.name];
	    }
	}
	this._queueRecalculate();
    },

    _hasDeps: function(task) {
	for (let depName in task.waitingDependencies) {
	    return true;
	}
	return false;
    },

    _reschedule: function() {
	while (this._executing.length < this.maxConcurrent &&
	       this._pendingTasksList.length > 0 &&
	       !this._hasDeps(this._pendingTasksList[0])) {
	    let task = this._pendingTasksList.shift();
	    print("TaskMaster: running: " + task.name);
	    let cls = task.def;
	    task.execute(this.cancellable);
	    this._executing.push(task);
	}
    }
});

const TaskDef = new Lang.Class({
    Name: 'TaskDef',

    TaskPattern: null,

    _init: function(taskmaster, name, inputs) {
	this.taskmaster = taskmaster;
	this.name = name;
	this.inputs = inputs;
    },

    getDepends: function(inputs) {
	return [];
    },

    execute: function(cancellable) {
	throw new Error("Not implemented");
    }
});

const SubTaskDef = new Lang.Class({
    Name: 'SubTaskDef',
    Extends: TaskDef,

    PreserveStdout: true,
    RetainFailed: 1,
    RetainSuccess: 5,

    _VERSION_RE: /(\d+\d\d\d\d)\.(\d+)/,

    _loadVersionsFrom: function(dir, cancellable) {
	let e = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, cancellable);
	let info;
	let results = [];
	while ((info = e.next_file(cancellable)) != null) {
	    let name = info.get_name();
	    let match = this._VERSION_RE.exec(name);
	    if (!match)
		continue;
	    results.push(name);
	}
	results.sort(BuildUtil.compareVersions);
	return results;
    },

    _cleanOldVersions: function(dir, retain, cancellable) {
	let versions = this._loadVersionsFrom(dir, cancellable);
	while (versions.length > retain) {
	    let child = dir.get_child(versions.shift());
	    GSystem.shutil_rm_rf(child, cancellable);
	}
    },

    executeSync: function(cancellable) {
	throw new Error("Not implemented");
    },

    execute: function(cancellable) {
	this._asyncOutstanding = 0;
	this._cancellable = cancellable;

	this._subtaskdir = this.taskmaster.path.resolve_relative_path(this.name.substr(1));
	GSystem.file_ensure_directory(this._subtaskdir, true, cancellable);
	
	let allVersions = [];

	this._successDir = this._subtaskdir.get_child('successful');
	GSystem.file_ensure_directory(this._successDir, true, cancellable);
	let successVersions = this._loadVersionsFrom(this._successDir, cancellable);
	for (let i = 0; i < successVersions.length; i++) {
	    allVersions.push([true, successVersions[i]]);
	}

	this._failedDir = this._subtaskdir.get_child('failed');
	GSystem.file_ensure_directory(this._failedDir, true, cancellable);
	let failedVersions = this._loadVersionsFrom(this._failedDir, cancellable);
	for (let i = 0; i < failedVersions.length; i++) {
	    allVersions.push([false, failedVersions[i]]);
	}

	allVersions.sort(function (a, b) {
	    let [successA, versionA] = a;
	    let [successB, versionB] = b;
	    return BuildUtil.compareVersions(versionA, versionB);
	});

	let currentTime = GLib.DateTime.new_now_utc();

	let currentYmd = Format.vprintf('%d%02d%02d', [currentTime.get_year(),
						       currentTime.get_month(),
						       currentTime.get_day_of_month()]);
	let version = null;
	if (allVersions.length > 0) {
	    let [lastSuccess, lastVersion] = allVersions[allVersions.length-1];
	    let match = this._VERSION_RE.exec(lastVersion);
	    if (!match) throw new Error();
	    let lastYmd = match[1];
	    let lastSerial = match[2];
	    if (lastYmd == currentYmd) {
		version = currentYmd + '.' + (parseInt(lastSerial) + 1);
	    }
	}
	if (version === null) {
	    version = currentYmd + '.0';
	}

	this._workdir = this._subtaskdir.get_child(version);
	GSystem.shutil_rm_rf(this._workdir, cancellable);
	GSystem.file_ensure_directory(this._workdir, true, cancellable);

	let baseArgv = ['ostbuild', 'run-task', this.name];
	let context = new GSystem.SubprocessContext({ argv: baseArgv });
	context.set_cwd(this._workdir.get_path());
	context.set_stdin_disposition(GSystem.SubprocessStreamDisposition.PIPE);
	if (this.PreserveStdout) {
	    let outPath = this._workdir.get_child('output.txt');
	    context.set_stdout_file_path(outPath.get_path());
	    context.set_stderr_disposition(GSystem.SubprocessStreamDisposition.STDERR_MERGE);
	} else {
	    context.set_stdout_disposition(GSystem.SubprocessStreamDisposition.NULL);
	    let errPath = this._workdir.get_child('errors.txt');
	    context.set_stderr_file_path(errPath.get_path());
	}
	let [success, resultpipe, fdno] = context.open_pipe_read(cancellable);
	context.argv_append(''+fdno);
	this._proc = new GSystem.Subprocess({ context: context });
	this._proc.init(cancellable);

	this._proc.wait(cancellable, Lang.bind(this, this._onChildExited));
	this._asyncOutstanding += 1;
	
	this._result = null;
	this._error = null;
	JsonUtil.loadJsonFromStreamAsync(resultpipe, cancellable, Lang.bind(this, this._onResultRead));
	this._asyncOutstanding += 1;
    },
    
    _onAsyncOpComplete: function(error) {
	this._asyncOutstanding--;
	if (error && !this._error)
	    this._error = error;
	if (this._asyncOutstanding != 0)
	    return;
	if (this._error) {
	    this.onComplete(null, this._error);
	} else {
	    this.onComplete(this._result, null);
	}
    },

    _onChildExited: function(proc, result) {
	let [success, errmsg] = ProcUtil.asyncWaitCheckFinish(proc, result);
	let target;
	if (!success) {
	    target = this._failedDir.get_child(this._workdir.get_basename());
	    GSystem.file_rename(this._workdir, target, null);
	    this._cleanOldVersions(this._failedDir, this.RetainFailed, null);
	    this._onAsyncOpComplete(new Error(errmsg));
	} else {
	    target = this._successDir.get_child(this._workdir.get_basename());
	    GSystem.file_rename(this._workdir, target, null);
	    this._cleanOldVersions(this._successDir, this.RetainSuccess, null);
	    this._onAsyncOpComplete(null);
	}
	print("Stored results of " + this.name + " in " + target.get_path());
    },

    _onResultRead: function(result, error) {
	if (!error) {
	    let childResult = result['result'];
	    if (childResult)
		this._result = childResult;
	    this._onAsyncOpComplete(null);
	} else {
	    this._onAsyncOpComplete(error);
	}
    }
});

function demo(argv) {
    var loop = GLib.MainLoop.new(null, true);
    let ecode = 1;
    var app = new TaskMaster('taskmaster/', {onEmpty: function() {
	print("TaskMaster: idle");
	loop.quit();
    }});
    for (let i = 0; i < argv.length; i++) {
	let taskName = argv[i];
	app.push(taskName);
    };
    loop.run();
    ecode = 0; 
    return ecode;
}
