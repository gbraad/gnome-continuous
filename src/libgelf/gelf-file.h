/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*-
 *
 * Copyright (C) 2013 Colin Walters <walters@verbum.org>.
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the
 * Free Software Foundation, Inc., 59 Temple Place - Suite 330,
 * Boston, MA 02111-1307, USA.
 */

#ifndef __GELF_FILE_H__
#define __GELF_FILE_H__

#include <gio/gio.h>

G_BEGIN_DECLS

#define GELF_TYPE_FILE         (gelf_file_get_type ())
#define GELF_FILE(o)           (G_TYPE_CHECK_INSTANCE_CAST ((o), GELF_TYPE_FILE, GElfFile))
#define GELF_IS_FILE(o)        (G_TYPE_CHECK_INSTANCE_TYPE ((o), GELF_TYPE_FILE))

typedef struct _GElfFile GElfFile;

GQuark           gelf_error_quark (void);

#define GELF_ERROR (gelf_error_quark ())

typedef enum {
  GELF_ERROR_NOT_ELF = 1,
  GELF_ERROR_INVALID
} GElfError;

GType            gelf_file_get_type (void) G_GNUC_CONST;

GElfFile *    gelf_file_new (GFile                 *path,
                             GCancellable          *cancellable,
                             GError               **error);

GElfFile *    gelf_file_maybe_new (GFile                 *path,
                                   GCancellable          *cancellable,
                                   GError               **error);

gboolean      gelf_file_get_build_id (GElfFile    *self,
                                      char       **out_build_id,
                                      GError     **error);

GList *       gelf_file_get_dt_needed (GElfFile    *self);

G_END_DECLS

#endif
