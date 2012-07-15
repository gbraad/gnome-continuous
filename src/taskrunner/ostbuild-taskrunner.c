/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*-
 *
 * Copyright (C) 2011 Colin Walters <walters@verbum.org>
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
 *
 * Author: Colin Walters <walters@verbum.org>
 */

#include "config.h"

#include <gio/gio.h>
#include <gio/gunixsocketaddress.h>
#include "libgsystem.h"

#include <string.h>

static gboolean verbose;

static GOptionEntry options[] = {
  { "verbose", 'v', 0, G_OPTION_ARG_NONE, &verbose, "Show more information", NULL },
  { NULL },
};

typedef struct {
  char *name;
  GPtrArray *depends;
  GPtrArray *args;
} OstbuildTaskrunnerTask;

typedef struct {
  GMainContext *context;
  GMainLoop *loop;
  GThreadedSocketService *task_service;
  
  GHashTable *tasks; /* char * -> OstbuildTaskrunnerTask */
} OstbuildTaskrunner;

typedef struct {
  OstbuildTaskrunner *self;
  OstbuildTaskrunnerTask *task;
} OstbuildTaskrunnerAddedTask;

static void
free_added_task (gpointer data)
{
  g_slice_free (OstbuildTaskrunnerAddedTask, data);
}

static gboolean
read_upto_utf8_and_consume (GDataInputStream     *datain,
                            const char           *stop_chars,
                            gssize                stop_chars_len,
                            char                **out_str,
                            char                 *out_consumed_char,
                            GCancellable         *cancellable,
                            GError              **error)
{
  gboolean ret = FALSE;
  GError *temp_error = NULL;
  gsize len;
  char ret_consumed_char;
  gs_lfree char *ret_str = NULL;

  ret_str = g_data_input_stream_read_upto (datain, stop_chars, stop_chars_len,
                                           &len, cancellable, &temp_error);
  if (temp_error)
    {
      g_propagate_error (error, temp_error);
      goto out;
    }

  if (ret_str)
    {
      if (!g_utf8_validate (ret_str, len, NULL))
        {
          g_set_error (error, G_IO_ERROR, G_IO_ERROR_FAILED,
                       "Invalid UTF-8");
          goto out;
        }
      
      ret_consumed_char = (char) g_data_input_stream_read_byte (datain, cancellable, &temp_error);
      if (temp_error)
        {
          g_propagate_error (error, temp_error);
          goto out;
        }
    }
  else
    ret_consumed_char = 0;

  ret = TRUE;
  *out_str = ret_str;
  ret_str = NULL;
  *out_consumed_char = ret_consumed_char;
 out:
  return ret;
}

static gboolean
idle_add_task (gpointer user_data)
{
  OstbuildTaskrunnerAddedTask *add_task = user_data;

  g_hash_table_insert (add_task->self->tasks,
                       add_task->task->name,
                       add_task->task);
  return FALSE;
}

static gboolean
handle_incoming_request (GThreadedSocketService     *service,
                         GSocketConnection          *connection,
                         GSocketListener            *listener,
                         gpointer                    user_data)
{
  OstbuildTaskrunner *self = user_data;
  GInputStream *in;
  GDataInputStream *datain;
  GError *local_error = NULL;
  GError **error = &local_error;
  GCancellable *cancellable = NULL;

  in = g_io_stream_get_input_stream ((GIOStream*)connection);
  datain = g_data_input_stream_new (in);

/*
task-foo-bar:depends-on-1:depends-on-2
foo\0--bar\0--baz\0\0
*/
  while (TRUE)
    {
      gs_lfree char *task_name = NULL;
      gs_lptrarray GPtrArray *depends = NULL;
      gs_lptrarray GPtrArray *task_args = NULL;
      
      if (!read_upto_utf8_and_consume (datain, ":", 1, &task_name, NULL,
                                       cancellable, error))
        goto out;
      if (!task_name)
        break;

      depends = g_ptr_array_new_with_free_func (g_free);

      while (TRUE)
        {
          gs_lfree char *dependency = NULL;
          char termchar;

          if (!read_upto_utf8_and_consume (datain, ":\n", 2, &dependency, &termchar,
                                           cancellable, error))
            goto out;
          if (!dependency)
            {
              g_set_error (error, G_IO_ERROR, G_IO_ERROR_FAILED,
                           "EOF while parsing task");
              goto out;
            }
          if (!dependency[0])
            {
              g_set_error (error, G_IO_ERROR, G_IO_ERROR_FAILED,
                           "Invalid empty dependency");
              goto out;
            }

          if (termchar == '\n')
            break;

          g_ptr_array_add (depends, dependency);
          dependency = NULL;
        }

      task_args = g_ptr_array_new_with_free_func (g_free);

      while (TRUE)
        {
          gs_lfree char *one_arg = NULL;
          char termchar;

          if (!read_upto_utf8_and_consume (datain, "\0", 1, &one_arg, &termchar,
                                           cancellable, error))
            goto out;
          if (!one_arg || strlen (one_arg) == 0)
            break;

          g_ptr_array_add (task_args, one_arg);
          one_arg = NULL;
        }

      {
        OstbuildTaskrunnerAddedTask *add_task = g_slice_new (OstbuildTaskrunnerAddedTask);
        OstbuildTaskrunnerTask *task = g_new0 (OstbuildTaskrunnerTask, 1);

        add_task->self = self;
        add_task->task = task;

        task->name = task_name;
        task_name = NULL;
        task->depends = depends;
        depends = NULL;
        task->args = task_args;
        task_args = NULL;
      
        g_main_context_invoke_full (self->context, G_PRIORITY_DEFAULT,
                                    idle_add_task, add_task, free_added_task);
      }
    }

  if (!g_io_stream_close ((GIOStream*)connection, NULL, error))
    goto out;

 out:
  if (local_error)
    {
      g_printerr ("Failed to read task: %s\n", local_error->message);
      g_clear_error (&local_error);
    }
  return TRUE;
}

static gboolean
init_taskrunner (OstbuildTaskrunner  *self,
                 GError             **error)
{
  gboolean ret = FALSE;
  GSocketAddress *src_addr = NULL;
  const char *socket_name = "taskrunner.socket";

  self->context = NULL;
  self->loop = g_main_loop_new (self->context, TRUE);
  
  self->task_service = (GThreadedSocketService*)g_threaded_socket_service_new (20);

  src_addr = g_unix_socket_address_new_with_type (socket_name, -1, G_UNIX_SOCKET_ADDRESS_PATH);

  if (!g_socket_listener_add_address ((GSocketListener*)self->task_service,
                                      src_addr, G_SOCKET_TYPE_STREAM,
                                      G_SOCKET_FAMILY_UNIX, NULL, NULL, error))
    goto out;

  g_signal_connect (self->task_service, "run", G_CALLBACK (handle_incoming_request), self);

  ret = TRUE;
 out:
  g_clear_object (&src_addr);
  return ret;
}

int
main (int    argc,
      char **argv)
{
  gboolean ret = FALSE;
  GError *local_error = NULL;
  GError **error = &local_error;
  GOptionContext *context;
  OstbuildTaskrunner self;

  memset (&self, 0, sizeof (self));

  context = g_option_context_new ("TASK - Execute a task that may create other tasks");
  g_option_context_add_main_entries (context, options, NULL);

  if (!g_option_context_parse (context, &argc, &argv, error))
    goto out;
  
  if (!init_taskrunner (&self, error))
    goto out;

  g_main_loop_run (self.loop);

  ret = TRUE;
 out:
  return ret ? 0 : 1;
}
