AC_PREREQ([2.63])
AC_INIT([gnome-ostree], [2012.4], [walters@verbum.org], [gnome-ostree], [https://live.gnome.org/OSTree/GnomeOSTree])
AC_CONFIG_HEADER([config.h])
AC_CONFIG_MACRO_DIR([m4])
AC_CONFIG_AUX_DIR([build-aux])

OS_NAME="GNOME-OSTree"
OS_ID=$PACKAGE_TARNAME
OS_VERSION=3.6
OS_PRETTY_NAME="$OS_NAME ($OS_VERSION, OE-Core edison, $PACKAGE_VERSION)"

AC_SUBST([OS_NAME])
AC_SUBST([OS_ID])
AC_SUBST([OS_VERSION])
AC_SUBST([OS_PRETTY_NAME])

AM_INIT_AUTOMAKE([1.11 -Wno-portability foreign no-define tar-ustar no-dist-gzip dist-xz])
AM_MAINTAINER_MODE([enable])
AM_SILENT_RULES([yes])

AC_PROG_CC
AM_PROG_CC_C_O

changequote(,)dnl
if test "x$GCC" = "xyes"; then
  WARN_CFLAGS="-Wall -Werror=strict-prototypes -Werror=missing-prototypes \
		-Werror=implicit-function-declaration \
		-Werror=pointer-arith -Werror=init-self -Werror=format=2 \
		-Werror=format-security \
		-Werror=missing-include-dirs -Werror=aggregate-return \
		-Werror=declaration-after-statement"
fi
changequote([,])dnl
AC_SUBST(WARN_CFLAGS)

# Initialize libtool
LT_PREREQ([2.2.4])
LT_INIT([disable-static])

GOBJECT_INTROSPECTION_REQUIRE([1.34.0])

AC_ARG_ENABLE(buildsystem,
	    AS_HELP_STRING([--disable-buildsystem], [Don't install buildsystem]),,
	    enable_buildsystem=yes)
AM_CONDITIONAL(BUILDSYSTEM, test x$enable_buildsystem != xno)

gio_unix_dep_version=2.34.0
PKG_CHECK_MODULES(GIO_UNIX, [gio-unix-2.0 >= ${gio_unix_dep_version}])
PKG_CHECK_MODULES(OSTBUILD_DEP, [gio-unix-2.0 >= ${gio_unix_dep_version}])

AC_CHECK_HEADER([libelf.h],,[AC_MSG_ERROR(libelf.h is required)])

AC_DEFINE(GLIB_VERSION_MIN_REQUIRED, [GLIB_VERSION_2_34], [Define to GLib min version])
AC_DEFINE(GLIB_VERSION_MAX_ALLOWED, [GLIB_VERSION_2_34], [Define to GLib max version])

AC_CONFIG_FILES([
Makefile
])
AC_OUTPUT

echo "
    GNOME-OSTree $VERSION
"
