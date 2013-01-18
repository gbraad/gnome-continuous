// Copyright (C) 2011 Colin Walters <walters@verbum.org>
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

const Format = imports.format;

const BUILTINS = ['autobuilder',
                  'checkout'
                  'prefix',
                  'git-mirror',
                  'resolve',
                  'build',
                  'shell',
                  'qa-make-disk',
                  'qa-build-disks',
		  'qa-pull-deploy',
		  'qa-smoketest'];

function getModule(unixName) {
    return imports.builtins[unixName.replace(/-/g, '_')];
}

function getClass(unixName) {
    let module = getModule(unixName);
    let camelParts = unixName.split(/-/);
    let camel = camelParts.map(function (part) {
	return part[0].toLocaleUpperCase() + part.substr(1);
    }).join('');
    return module[camel];
}

function usage(ecode) {
    print("Builtins:");
    for (let i = 0; i < BUILTINS.length; i++) {
	let unixName = BUILTINS[i];
	let description = getClass(unixName).DESCRIPTION;
        print(Format.vprintf("    %s - %s", [unixName, description]));
    }
    return ecode;
}

if (ARGV.length < 1) {
    usage(1);
} else if (ARGV[0] == '-h' || ARGV[0] == '--help') {
    usage(0);
} else {
    let name = ARGV[0];
    if (!BUILTINS[name]) {
	usage(1);
    }
    let args = ARGV.concat();
    args.shift();

    let ecode = 1;
    let loop = GLib.MainLoop.new(null, true);
    let instance = new getClass(name);
    let cancellable = null;
    GLib.idle_add(GLib.PRIORITY_DEFAULT,
		  function() {
		      try {
			  instance.execute(args, loop, cancellable); ecode = 0;
		      } finally {
			  loop.quit();
		      }
		      return false;
		  });
    loop.run();
    return ecode;
}
    
    
