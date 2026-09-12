/**
 * Personal-agent tools. The model mutates the signed-in student's notes, todos,
 * class files, and class names. Execution stays on this Mac.
 */

import {
  createNote,
  deleteNote,
  listNotes,
  loadNote,
  patchNoteSubject,
  publicNote,
  publicNoteRow,
  updateNoteText,
} from "./notes.js";
import { loadSchedule, matchClassByLabel } from "./schedule.js";
import {
  createTodo,
  deleteClassFile,
  deleteTodo,
  deleteTodoFile,
  hideCanvasTodo,
  isLocalTodoId,
  listAllTodoFiles,
  listClassFiles,
  listTodoFiles,
  listTodos,
  loadWorkspaceMeta,
  parseClassFileId,
  parseTodoFileId,
  patchTodo,
  readClassFile,
  readTodoFile,
  renameClass,
  setCanvasTodoDone,
  writeClassFile,
  writeTodoFile,
} from "./workspace.js";
import {
  downloadFile,
  ensureFreshToken as ensureGraphToken,
  listDashboardFiles,
  searchFiles,
  uploadFile,
} from "./onedrive.js";
import {
  createPage as createOnenotePage,
  getPage as getOnenotePage,
  listNotebooks,
  listPages as listOnenotePages,
  listSections as listOnenoteSections,
  onenoteError,
} from "./onenote.js";
import {
  ensureFreshToken as ensureOutlookToken,
  listEvents,
  listMessages,
  readMessage,
  sendMessage,
} from "./outlook.js";
import {
  ensureFreshToken as ensureTeamsToken,
  listChatMessages as listGraphTeamMessages,
  listChats as listGraphTeamChats,
  sendChatMessage as sendGraphTeamMessage,
} from "./teams.js";
import {
  isStudioDemoStudent,
  listStudioChatMessages,
  listStudioChats,
  listStudioFiles,
  readStudioFile,
  sendStudioChat,
  studioFlags,
  studioOutlookToken,
  writeStudioFile,
} from "./studio-ms.js";
import { mergeGraph, mergeOutlook, mergeTeams, saveStudent } from "./students.js";

const MAX_RESULT = 6000;

function clip(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= MAX_RESULT) return text;
  return `${text.slice(0, MAX_RESULT - 1)}…`;
}

function ok(payload, extra = {}) {
  return { text: clip(payload), ...extra };
}

function fail(message) {
  return { text: clip({ error: String(message || "Tool failed.") }) };
}

export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_notes",
      description: "List the student's saved notes (title, class, id). Use before editing or deleting.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description: "Read the full text of one note.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Note id" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_note",
      description: "Create a note from pasted text. Classifies it onto a class.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Full note body" },
          subject: { type: "string", description: "Optional class name to assign after create" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_note",
      description: "Rewrite a note's text and/or move it to another class.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          subject: { type: "string", description: "Class name or Other" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_note",
      description: "Permanently delete a note.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_todos",
      description: "List local todos the student added (not the Canvas snapshot).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "add_todo",
      description: "Add a local todo. Use for homework the student asks to track.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          classId: { type: "string", description: "Schedule class id if known" },
          className: { type: "string" },
          due: { type: "string", description: "YYYY-MM-DD or ISO datetime" },
          tag: { type: "string", description: "CW | HW | QA | MA" },
          description: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_todo",
      description: "Edit a local todo's title, class, due date, tag, or description.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          classId: { type: "string" },
          className: { type: "string" },
          due: { type: "string" },
          tag: { type: "string" },
          description: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_todo",
      description: "Check a todo done. Local only. Does not change Canvas.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          done: { type: "boolean", description: "Default true. Set false to uncheck." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_todo",
      description: "Delete a local todo, or hide a Canvas assignment from the list.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_classes",
      description: "List the student's schedule classes (id, name, period).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_class",
      description: "Change the display name of a class on Home and the class page.",
      parameters: {
        type: "object",
        properties: {
          classId: { type: "string", description: "Class id, or the current name" },
          name: { type: "string", description: "New display name" },
        },
        required: ["classId", "name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_class_files",
      description: "List files saved on a class, including HTML pages.",
      parameters: {
        type: "object",
        properties: { classId: { type: "string" } },
        required: ["classId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_class_file",
      description:
        "Create or replace a file on a class. Use for notes, study sheets, or a standalone .html page.",
      parameters: {
        type: "object",
        properties: {
          classId: { type: "string" },
          name: { type: "string", description: "File name, e.g. quiz-review.html" },
          content: { type: "string", description: "Full file text" },
          contentType: { type: "string" },
        },
        required: ["classId", "name", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_class_file",
      description: "Read a class file's text.",
      parameters: {
        type: "object",
        properties: {
          classId: { type: "string" },
          name: { type: "string" },
          id: { type: "string", description: "class:id:name from list_class_files" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_class_file",
      description: "Delete a file from a class.",
      parameters: {
        type: "object",
        properties: {
          classId: { type: "string" },
          name: { type: "string" },
          id: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_todo_files",
      description: "List files saved on a todo page. Omit todoId to list every todo file.",
      parameters: {
        type: "object",
        properties: { todoId: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_todo_file",
      description:
        "Create or replace a file on a todo page. Use for notes, study sheets, or a standalone .html page.",
      parameters: {
        type: "object",
        properties: {
          todoId: { type: "string" },
          name: { type: "string", description: "File name, e.g. outline.html" },
          content: { type: "string", description: "Full file text" },
          contentType: { type: "string" },
        },
        required: ["todoId", "name", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_todo_file",
      description: "Read a todo file's text.",
      parameters: {
        type: "object",
        properties: {
          todoId: { type: "string" },
          name: { type: "string" },
          id: { type: "string", description: "todo:id:name from list_todo_files" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_todo_file",
      description: "Delete a file from a todo page.",
      parameters: {
        type: "object",
        properties: {
          todoId: { type: "string" },
          name: { type: "string" },
          id: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_onedrive_files",
      description: "List school OneDrive files (Graph or this Mac's Finder folder).",
      parameters: {
        type: "object",
        properties: { q: { type: "string", description: "Optional name search" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_onedrive_file",
      description: "Read a OneDrive or Finder file. Use an id from list_onedrive_files.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_onenote_notebooks",
      description: "List school OneNote notebooks. Uses the OneDrive Microsoft sign-in.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_onenote_sections",
      description: "List OneNote sections in a notebook, or all sections if notebookId is omitted.",
      parameters: {
        type: "object",
        properties: { notebookId: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_onenote_pages",
      description: "List OneNote pages in a section, or search pages by keyword.",
      parameters: {
        type: "object",
        properties: {
          sectionId: { type: "string" },
          q: { type: "string", description: "Search titles and content" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_onenote_page",
      description: "Read one OneNote page as text. Use an id from list_onenote_pages.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_onenote_page",
      description: "Create a OneNote page in a section. Pass title plus text or HTML.",
      parameters: {
        type: "object",
        properties: {
          sectionId: { type: "string" },
          title: { type: "string" },
          text: { type: "string" },
          html: { type: "string" },
        },
        required: ["sectionId", "title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_onedrive_file",
      description: "Write a file to school OneDrive / the Finder folder (EPSynapse).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          content: { type: "string" },
          contentType: { type: "string" },
        },
        required: ["name", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_outlook_mail",
      description: "List recent school Outlook inbox messages.",
      parameters: {
        type: "object",
        properties: {
          q: { type: "string" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_outlook_mail",
      description: "Read one Outlook message body.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_outlook_mail",
      description: "Send a school Outlook email.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_outlook_events",
      description: "List school Outlook calendar events.",
      parameters: {
        type: "object",
        properties: { days: { type: "number" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_teams_chats",
      description: "List school Teams chats.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_teams_thread",
      description: "Read recent messages in a Teams chat. Use a chat id or name from list_teams_chats.",
      parameters: {
        type: "object",
        properties: {
          chat: { type: "string" },
          limit: { type: "number" },
        },
        required: ["chat"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_teams_message",
      description: "Send a message to a school Teams chat.",
      parameters: {
        type: "object",
        properties: {
          chat: { type: "string" },
          text: { type: "string" },
        },
        required: ["chat", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_page",
      description:
        "Open a dashboard page when this turn finishes. Call after creating something the student should see.",
      parameters: {
        type: "object",
        properties: {
          view: { type: "string", description: "home | class | note | todo" },
          classId: { type: "string" },
          noteId: { type: "string" },
          todoId: { type: "string" },
        },
        required: ["view"],
        additionalProperties: false,
      },
    },
  },
];

async function resolveClass(ownerId, student, raw) {
  const label = String(raw || "").trim();
  if (!label) return null;
  const schedule = await loadSchedule(ownerId).catch(() => ({ classes: [] }));
  const aliases = (await loadWorkspaceMeta(ownerId).catch(() => ({ classAliases: {} }))).classAliases;
  const rows = (schedule.classes || []).map((c) => {
    const alias = aliases[c.id] || aliases[String(c.name || "").toLowerCase()];
    return alias ? { ...c, name: alias } : c;
  });
  return (
    matchClassByLabel(rows, label) ||
    rows.find((c) => String(c.id) === label) ||
    null
  );
}

function fileTarget(input) {
  if (input?.id) {
    const parsed = parseClassFileId(input.id);
    if (parsed) return parsed;
  }
  return {
    classId: String(input?.classId || "").trim(),
    name: String(input?.name || "").trim(),
  };
}

function todoFileTarget(input) {
  if (input?.id) {
    const parsed = parseTodoFileId(input.id);
    if (parsed) return parsed;
  }
  return {
    todoId: String(input?.todoId || "").trim(),
    name: String(input?.name || "").trim(),
  };
}

async function graphAccess(student) {
  if (!student?.graph?.accessToken) return "";
  const fresh = await ensureGraphToken(student.graph);
  if (fresh !== student.graph) {
    mergeGraph(student, fresh);
    await saveStudent(student);
  }
  return fresh.accessToken;
}

async function mailAccess(student) {
  if (student?.outlook?.accessToken) {
    const fresh = await ensureOutlookToken(student.outlook);
    if (fresh !== student.outlook) {
      mergeOutlook(student, fresh);
      await saveStudent(student);
    }
    return fresh.accessToken;
  }
  if (isStudioDemoStudent(student)) return studioOutlookToken();
  return "";
}

async function teamsGraphAccess(student) {
  if (!student?.teams?.accessToken) return "";
  const fresh = await ensureTeamsToken(student.teams);
  if (fresh !== student.teams) {
    mergeTeams(student, fresh);
    await saveStudent(student);
  }
  return fresh.accessToken;
}

export async function executeAgentTool(call, { ownerId, student, req } = {}) {
  const name = String(call?.function?.name || call?.name || "").trim();
  let input = {};
  const rawArgs = call?.function?.arguments ?? call?.arguments ?? {};
  if (typeof rawArgs === "string") {
    try {
      input = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return fail("Bad tool arguments.");
    }
  } else if (rawArgs && typeof rawArgs === "object") {
    input = rawArgs;
  }

  if (!ownerId) return fail("Sign in with Google first.");

  try {
    switch (name) {
      case "list_notes": {
        const notes = await listNotes(ownerId);
        return ok({ notes: notes.map(publicNoteRow) }, { kinds: ["notes"] });
      }
      case "read_note": {
        const note = publicNote(await loadNote(ownerId, input.id));
        return ok({ note });
      }
      case "add_note": {
        let note = await createNote(ownerId, input.text, { req, student });
        if (input.subject) {
          note = await patchNoteSubject(ownerId, note.id, input.subject, { student });
        }
        return ok({ note: publicNote(note) }, { kinds: ["notes"], navigate: { view: "note", noteId: note.id } });
      }
      case "update_note": {
        if (input.text != null) await updateNoteText(ownerId, input.id, input.text);
        let note = await loadNote(ownerId, input.id);
        if (input.subject != null && String(input.subject).trim()) {
          note = await patchNoteSubject(ownerId, input.id, input.subject, { student });
        }
        return ok({ note: publicNote(note) }, { kinds: ["notes"] });
      }
      case "delete_note": {
        const deleted = await deleteNote(ownerId, input.id);
        return ok(deleted, { kinds: ["notes"], navigate: { view: "home" } });
      }
      case "list_todos": {
        return ok({ todos: await listTodos(ownerId) });
      }
      case "add_todo": {
        const klass = await resolveClass(ownerId, student, input.classId || input.className);
        const todo = await createTodo(ownerId, {
          ...input,
          classId: klass?.id || input.classId || "",
          courseName: klass?.name || input.className || input.courseName || "",
        });
        return ok({ todo }, { kinds: ["todos"], navigate: klass ? { view: "class", classId: klass.id } : { view: "home" } });
      }
      case "update_todo": {
        if (!isLocalTodoId(input.id)) return fail("That Canvas item can be checked off, not edited.");
        const klass = await resolveClass(ownerId, student, input.classId || input.className);
        const todo = await patchTodo(ownerId, input.id, {
          ...input,
          classId: klass?.id || input.classId,
          courseName: klass?.name || input.className || input.courseName,
        });
        return ok({ todo }, { kinds: ["todos"] });
      }
      case "complete_todo": {
        const done = input.done !== false;
        if (isLocalTodoId(input.id)) {
          const todo = await patchTodo(ownerId, input.id, { done });
          return ok({ todo }, { kinds: ["todos"] });
        }
        const saved = await setCanvasTodoDone(ownerId, input.id, done);
        return ok({ todo: saved }, { kinds: ["todos"] });
      }
      case "delete_todo": {
        if (isLocalTodoId(input.id)) {
          return ok(await deleteTodo(ownerId, input.id), { kinds: ["todos"] });
        }
        return ok(await hideCanvasTodo(ownerId, input.id), { kinds: ["todos"] });
      }
      case "list_classes": {
        const stored = await loadSchedule(ownerId).catch(() => ({ classes: [] }));
        const meta = await loadWorkspaceMeta(ownerId);
        const classes = (stored.classes || [])
          .filter((c) => !c.freePeriod)
          .map((c) => ({
            id: c.id,
            name: meta.classAliases[c.id] || c.name,
            period: c.period || "",
            subject: c.subject || "",
          }));
        return ok({ classes });
      }
      case "rename_class": {
        const klass = await resolveClass(ownerId, student, input.classId);
        const id = klass?.id || String(input.classId || "").trim();
        const renamed = await renameClass(ownerId, id, input.name, klass?.name || "");
        return ok(renamed, { kinds: ["classes"], navigate: { view: "class", classId: id } });
      }
      case "list_class_files": {
        const klass = await resolveClass(ownerId, student, input.classId);
        const classId = klass?.id || input.classId;
        const files = await listClassFiles(ownerId, classId, { includeText: false });
        return ok({ classId, files });
      }
      case "write_class_file": {
        const klass = await resolveClass(ownerId, student, input.classId);
        const classId = klass?.id || input.classId;
        const file = await writeClassFile(ownerId, classId, {
          name: input.name,
          content: input.content,
          contentType: input.contentType,
        });
        const { text: _text, ...meta } = file;
        return ok({ file: meta }, { kinds: ["files"], navigate: { view: "class", classId } });
      }
      case "read_class_file": {
        const target = fileTarget(input);
        const klass = await resolveClass(ownerId, student, target.classId);
        const classId = klass?.id || target.classId;
        const file = await readClassFile(ownerId, classId, target.name);
        const text = isProbablyText(file.contentType, file.name)
          ? file.buffer.toString("utf8").slice(0, MAX_RESULT)
          : `[binary ${file.buffer.length} bytes]`;
        return ok({ name: file.name, classId, contentType: file.contentType, content: text });
      }
      case "delete_class_file": {
        const target = fileTarget(input);
        const klass = await resolveClass(ownerId, student, target.classId);
        const classId = klass?.id || target.classId;
        return ok(await deleteClassFile(ownerId, classId, target.name), { kinds: ["files"] });
      }
      case "list_todo_files": {
        const todoId = String(input.todoId || "").trim();
        const files = todoId
          ? await listTodoFiles(ownerId, todoId, { includeText: false })
          : await listAllTodoFiles(ownerId, { includeText: false });
        return ok({ todoId, files });
      }
      case "write_todo_file": {
        const todoId = String(input.todoId || "").trim();
        const file = await writeTodoFile(ownerId, todoId, {
          name: input.name,
          content: input.content,
          contentType: input.contentType,
        });
        const { text: _text, ...meta } = file;
        return ok(
          { file: meta },
          { kinds: ["files"], navigate: { view: "todo", todoId: file.todoId || todoId } }
        );
      }
      case "read_todo_file": {
        const target = todoFileTarget(input);
        const file = await readTodoFile(ownerId, target.todoId, target.name);
        const text = isProbablyText(file.contentType, file.name)
          ? file.buffer.toString("utf8").slice(0, MAX_RESULT)
          : `[binary ${file.buffer.length} bytes]`;
        return ok({ name: file.name, todoId: file.todoId, contentType: file.contentType, content: text });
      }
      case "delete_todo_file": {
        const target = todoFileTarget(input);
        return ok(await deleteTodoFile(ownerId, target.todoId, target.name), {
          kinds: ["files"],
          navigate: { view: "todo", todoId: target.todoId },
        });
      }
      case "list_onedrive_files": {
        const q = String(input.q || "").trim();
        const token = await graphAccess(student);
        let files = [];
        if (token) {
          files = q ? await searchFiles(token, q) : await listDashboardFiles(token, {});
        }
        if (studioFlags(student).onedrive) {
          files = [...files, ...(await listStudioFiles({ q, limit: 40 }))];
        }
        if (!files.length && !token && !studioFlags(student).onedrive) {
          return fail("Connect OneDrive in settings first.");
        }
        return ok({ files: files.slice(0, 40) });
      }
      case "read_onedrive_file": {
        const id = String(input.id || "").trim();
        if (!id) return fail("File id required.");
        if (id.startsWith("studio:") || (!student?.graph?.accessToken && studioFlags(student).onedrive)) {
          const file = await readStudioFile(id);
          const text = isProbablyText(file.contentType, file.name)
            ? file.buffer.toString("utf8").slice(0, MAX_RESULT)
            : `[binary ${file.buffer.length} bytes]`;
          return ok({ name: file.name, contentType: file.contentType, content: text, path: file.path });
        }
        const token = await graphAccess(student);
        if (!token) return fail("Connect OneDrive in settings first.");
        const file = await downloadFile(token, id);
        const text = isProbablyText(file.contentType, file.name)
          ? file.buffer.toString("utf8").slice(0, MAX_RESULT)
          : `[binary ${file.buffer.length} bytes]`;
        return ok({ name: file.name, contentType: file.contentType, content: text });
      }
      case "list_onenote_notebooks": {
        const token = await graphAccess(student);
        if (!token) return fail("Connect OneDrive in settings first. OneNote uses that sign-in.");
        try {
          return ok({ notebooks: await listNotebooks(token) });
        } catch (err) {
          return fail(onenoteError(err));
        }
      }
      case "list_onenote_sections": {
        const token = await graphAccess(student);
        if (!token) return fail("Connect OneDrive in settings first. OneNote uses that sign-in.");
        try {
          return ok({ sections: await listOnenoteSections(token, input.notebookId) });
        } catch (err) {
          return fail(onenoteError(err));
        }
      }
      case "list_onenote_pages": {
        const token = await graphAccess(student);
        if (!token) return fail("Connect OneDrive in settings first. OneNote uses that sign-in.");
        try {
          return ok({
            pages: await listOnenotePages(token, {
              sectionId: input.sectionId,
              q: input.q,
              limit: Number(input.limit) || 20,
            }),
          });
        } catch (err) {
          return fail(onenoteError(err));
        }
      }
      case "read_onenote_page": {
        const token = await graphAccess(student);
        if (!token) return fail("Connect OneDrive in settings first. OneNote uses that sign-in.");
        try {
          return ok({ page: await getOnenotePage(token, input.id) });
        } catch (err) {
          return fail(onenoteError(err));
        }
      }
      case "create_onenote_page": {
        const token = await graphAccess(student);
        if (!token) return fail("Connect OneDrive in settings first. OneNote uses that sign-in.");
        try {
          return ok(
            await createOnenotePage(token, {
              sectionId: input.sectionId,
              title: input.title,
              text: input.text,
              html: input.html,
            })
          );
        } catch (err) {
          return fail(onenoteError(err));
        }
      }
      case "write_onedrive_file": {
        const name = String(input.name || "").trim();
        const content = String(input.content ?? "");
        const contentType = String(input.contentType || "text/plain");
        const out = {};
        if (studioFlags(student).onedrive) {
          out.studio = await writeStudioFile({ name, content, contentType });
        }
        const token = await graphAccess(student);
        if (token) {
          out.onedrive = await uploadFile(token, { name, content, contentType });
        }
        if (!out.studio && !out.onedrive) return fail("Connect OneDrive in settings first.");
        return ok(out, { kinds: ["files"] });
      }
      case "list_outlook_mail": {
        const token = await mailAccess(student);
        if (!token) return fail("Connect Outlook in settings first.");
        return ok({
          messages: await listMessages(token, {
            search: String(input.q || "").trim(),
            limit: Number(input.limit) || 12,
          }),
        });
      }
      case "read_outlook_mail": {
        const token = await mailAccess(student);
        if (!token) return fail("Connect Outlook in settings first.");
        return ok({ message: await readMessage(token, input.id) });
      }
      case "send_outlook_mail": {
        const token = await mailAccess(student);
        if (!token) return fail("Connect Outlook in settings first.");
        return ok(
          await sendMessage(token, { to: input.to, subject: input.subject, body: input.body })
        );
      }
      case "list_outlook_events": {
        const token = await mailAccess(student);
        if (!token) return fail("Connect Outlook in settings first.");
        return ok({ events: await listEvents(token, { days: Number(input.days) || 7 }) });
      }
      case "list_teams_chats": {
        const token = await teamsGraphAccess(student);
        if (token) return ok({ chats: await listGraphTeamChats(token, { limit: Number(input.limit) || 20 }) });
        if (studioFlags(student).teams) {
          return ok({ chats: await listStudioChats({ limit: Number(input.limit) || 20 }) });
        }
        return fail("Connect Teams in settings first.");
      }
      case "read_teams_thread": {
        const chat = String(input.chat || "").trim();
        const token = await teamsGraphAccess(student);
        if (token) {
          return ok({
            messages: await listGraphTeamMessages(token, chat, { limit: Number(input.limit) || 20 }),
          });
        }
        if (studioFlags(student).teams) {
          return ok({ messages: await listStudioChatMessages(chat, { limit: Number(input.limit) || 20 }) });
        }
        return fail("Connect Teams in settings first.");
      }
      case "send_teams_message": {
        const token = await teamsGraphAccess(student);
        if (token) {
          return ok(await sendGraphTeamMessage(token, { chat: input.chat, text: input.text }));
        }
        if (studioFlags(student).teams) {
          return ok(await sendStudioChat({ chat: input.chat, text: input.text }));
        }
        return fail("Connect Teams in settings first.");
      }
      case "open_page": {
        const view = String(input.view || "home").trim().toLowerCase();
        if (!["home", "class", "note", "todo"].includes(view)) {
          return fail("view must be home, class, note, or todo.");
        }
        return ok(
          { queued: view },
          {
            navigate: {
              view,
              classId: input.classId || "",
              noteId: input.noteId || "",
              todoId: input.todoId || "",
            },
          }
        );
      }
      default:
        return fail(`Unknown tool ${name}`);
    }
  } catch (err) {
    return fail(err?.message || "Tool failed.");
  }
}

function isProbablyText(contentType, name) {
  const type = String(contentType || "").toLowerCase();
  const lower = String(name || "").toLowerCase();
  return (
    type.startsWith("text/") ||
    type.includes("json") ||
    type.includes("javascript") ||
    /\.(html?|md|txt|css|js|json|xml|svg)$/i.test(lower)
  );
}

export function normalizeNavigate(raw) {
  if (!raw || typeof raw !== "object") return null;
  const view = String(raw.view || "").trim().toLowerCase();
  if (view === "home") return { view: "home" };
  if (view === "class") {
    const classId = String(raw.classId || "").trim();
    return classId ? { view: "class", classId } : { view: "home" };
  }
  if (view === "note") {
    const noteId = String(raw.noteId || "").trim();
    return noteId ? { view: "note", noteId } : { view: "home" };
  }
  if (view === "todo") {
    const todoId = String(raw.todoId || "").trim();
    return todoId ? { view: "todo", todoId } : { view: "home" };
  }
  return null;
}

export function navigateHref(nav) {
  if (!nav) return "/";
  if (nav.view === "class" && nav.classId) return `/class/${encodeURIComponent(nav.classId)}`;
  if (nav.view === "note" && nav.noteId) return `/note/${encodeURIComponent(nav.noteId)}`;
  if (nav.view === "todo" && nav.todoId) return `/todo/${encodeURIComponent(nav.todoId)}`;
  return "/";
}
