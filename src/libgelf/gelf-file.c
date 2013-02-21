/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*-
 *
 * Copyright © 2013 Colin Walters <walters@verbum.org>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published
 * by the Free Software Foundation; either version 2 of the licence or (at
 * your option) any later version.
 *
 * See the included COPYING file for more information.
 */

#include "config.h"

#include "gelf-file.h"

/**
 * SECTION:gelffile
 * @title: GElfFile
 * @short_description: Read an ELF object
 *
 * This class provides a high-level API for inspecting ELF object
 * files.
 */

#include "config.h"

#include "gelf-file.h"

#include "libelf.h"
#include <gio/gfiledescriptorbased.h>

#include <string.h>
#include <glib-unix.h>

static void initable_iface_init (GInitableIface         *initable_iface);

typedef GObjectClass GElfFileClass;

struct _GElfFile
{
  GObject parent;

  GFile *path;
  GFileInputStream *stream;
  Elf *elf;
  Ebl *ebl;
  guint shnum;
  guint phnum;
};

G_DEFINE_TYPE_WITH_CODE (GElfFile, gelf_file, G_TYPE_OBJECT,
                         G_IMPLEMENT_INTERFACE (G_TYPE_INITABLE, initable_iface_init));

enum
{
  PROP_0,
  PROP_PATH,
  N_PROPS
};

static GParamSpec *gelf_file_pspecs[N_PROPS];

static void
gelf_file_init (GElfFile  *self)
{
}

static void
gelf_file_finalize (GObject *object)
{
  GElfFile *self = GELF_FILE (object);

  if (self->elf)
    elf_end (self->elf);
  if (self->ebl)
    ebl_closebackend (self->ebl);

  g_clear_object (&self->path);
  g_clear_object (&self->stream);

  if (G_OBJECT_CLASS (gelf_file_parent_class)->finalize != NULL)
    G_OBJECT_CLASS (gelf_file_parent_class)->finalize (object);
}

static void
gelf_file_set_property (GObject      *object,
                           guint         prop_id,
                           const GValue *value,
                           GParamSpec   *pspec)
{
  GElfFile *self = GELF_FILE (object);

  switch (prop_id)
    {
    case PROP_PATH:
      self->path = g_value_dup_object (value);
      break;

    default:
      g_assert_not_reached ();
    }
}

static void
gelf_file_get_property (GObject    *object,
                        guint       prop_id,
                        GValue     *value,
                        GParamSpec *pspec)
{
  GElfFile *self = GELF_FILE (object);

  switch (prop_id)
    {
    case PROP_PATH:
      g_value_set_object (value, self->path);
      break;

    default:
      g_assert_not_reached ();
    }
}

static void
gelf_file_class_init (GElfFileClass *class)
{
  GObjectClass *gobject_class = G_OBJECT_CLASS (class);

  gobject_class->finalize = gelf_file_finalize;
  gobject_class->get_property = gelf_file_get_property;
  gobject_class->set_property = gelf_file_set_property;

  gelf_file_pspecs[PROP_PATH] = g_param_spec_object ("path", "", "", G_TYPE_FILE,
                                                     G_PARAM_READWRITE | G_PARAM_CONSTRUCT_ONLY |
                                                     G_PARAM_STATIC_STRINGS);

  g_object_class_install_properties (gobject_class, N_PROPS, gelf_file_pspecs);
}

G_DEFINE_QUARK (gelf-error-quark, gelf_error)

static void
set_elf_error (Elf     *elf,
               GError **error)
{
  g_set_error_literal (error, GELF_ERROR, GELF_ERROR_INVALID,
                       elf_errmsg (elf_errno ()));
}

static gboolean
initable_init (GInitable     *initable,
               GCancellable  *cancellable,
               GError       **error)
{
  GElfFile *self = GELF_FILE (initable);
  gboolean ret = FALSE;
  int fd;
  Elf_Kind kind;

  if (g_cancellable_set_error_if_cancelled (cancellable, error))
    return FALSE;

  self->stream = g_file_read (self->path, cancellable, error);
  if (!self->stream)
    goto out;

  (void) elf_version (EV_CURRENT);

  g_assert (G_IS_FILE_DESCRIPTOR_BASED (self->stream));
  fd = g_file_descriptor_based_get_fd ((GFileDescriptorBased*) self->stream);

  self->elf = elf_begin (fd, ELF_C_READ_MMAP, NULL);
  if (!self->elf)
    {
      set_elf_error (self->elf, error);
      goto out;
    }
  
  kind = elf_kind (self->elf);
  if (kind != ELF_K_ELF)
    {
      g_set_error (error, GELF_ERROR, GELF_ERROR_NOT_ELF,
                   "Not an ELF file");
      goto out;
    }

  self->ebl = ebl_openbackend (self->elf);

  if (elf_getshdrnum (self->ebl->elf, &self->shnum) < 0)
    {
      set_elf_error (self->ebl->elf, error);
      goto out;
    }

  if (elf_getphdrnum (self->ebl->elf, &self->phnum) < 0)
    {
      set_elf_error (self->ebl->elf, error);
      goto out;
    }

  ret = TRUE;
 out:
  return ret;
}

static void
initable_iface_init (GInitableIface *initable_iface)
{
  initable_iface->init = initable_init;
}

/**
 * gelf_file_new:
 * @path: Path to ELF file
 * @cancellable:
 * @error:
 *
 * Create a new #GElfFile; will throw an error if @path is not ELF.
 *
 * Returns: (transfer full): A newly created %GElfFile, or %NULL on error (and @error will be set)
 */
GElfFile *
gelf_file_new (GFile                 *path,
               GCancellable          *cancellable,
               GError               **error)
{
  return g_initable_new (GELF_TYPE_FILE,
                         cancellable, error,
                         "path", path,
                         NULL);
}

/**
 * gelf_file_maybe_new:
 * @path: Path to ELF file
 * @cancellable:
 * @error:
 *
 * Create a new #GElfFile; if @path is not ELF, then %NULL will be
 * returned, and @error will not be set.
 *
 * Returns: (transfer full): A newly created %GElfFile, or %NULL on error (and @error will be set)
 */
GElfFile *
gelf_file_maybe_new (GFile                 *path,
                     GCancellable          *cancellable,
                     GError               **error)
{
  GError *tmp_error = NULL;
  GElfFile *ret;

  ret = g_initable_new (GELF_TYPE_FILE,
                        cancellable, &tmp_error,
                        "path", path,
                        NULL);
  if (tmp_error != NULL)
    {
      if (g_error_matches (tmp_error, GELF_ERROR, GELF_ERROR_NOT_ELF))
        g_clear_error (&tmp_error);
      else
        g_propagate_error (error, tmp_error);
    }

  return ret;
}

static 

/**
 * gelf_file_get_build_id:
 * @self:
 * @out_build_id: (out) (allow-none): Build-Id, or %NULL if none found
 *
 * Returns: %TRUE on success, %FALSE on error
 */
gboolean
gelf_file_get_build_id (GElfFile *self,
                        char    **out_build_id,
                        GError  **error)
{
  gboolean ret = FALSE;
  char *ret_build_id = NULL;
  Elf_Scn *scn = NULL;

  if (self->shnum > 0)
    {
      size_t shstrndx;
      if (elf_getshdrstrndx (self->ebl->elf, &shstrndx) < 0)
        {
          set_elf_error (self->ebl->elf, error);
          goto out;
        }
      while ((scn = elf_nextscn (self->ebl->elf, scn)) != NULL)
        {
	  GElf_Shdr shdr_mem;
	  GElf_Shdr *shdr = gelf_getshdr (scn, &shdr_mem);
          GElf_Off start;
          Elf_Data *data;

	  if (shdr == NULL || shdr->sh_type != SHT_NOTE)
	    continue;

          start = shdr->sh_offset;
          data = elf_getdata (scn, NULL);

          if (data == NULL)
            continue;
          
        }
    }

 out:
  if (out_build_id)
    *out_build_id = ret_build_id;
  else
    g_free (ret_build_id);
  return ret;
}

/**
 * gelf_file_get_dt_needed:
 * @self:
 *
 * Returns: (transfer full) (element-type utf8): the list of DT_NEEDED entries
 */
GList *
gelf_file_get_dt_needed (GElfFile *self)
{
  return NULL;
}
