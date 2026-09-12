/**
 * Personal-agent tools. The model mutates the signed-in student's notes, todos,
 * class files, and class names. Execution stays on this Mac.
 */

import {
  markAssignmentComplete,
  markAssignmentIncomplete,
} from "./canvas.js";
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
  hideCanvasTodo,
  isLocalTodoId,
  listClassFiles,
  listTodos,
  loadWorkspaceMeta,
  parseClassFileId,
  patchTodo,
  readClassFile,
  renameClass,
  writeClassFile,
} from "./workspace.js";

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
      description: "Check a todo done. Works for local todos and Canvas assignments.",
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
      name: "open_page",
      description:
        "Open a dashboard page when this turn finishes. Call after creating something the student should see.",
      parameters: {
        type: "object",
        properties: {
          view: { type: "string", description: "home | class | note" },
          classId: { type: "string" },
          noteId: { type: "string" },
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
        if (!student?.canvasToken) return fail("Connect Canvas to check off that assignment.");
        const saved = done
          ? await markAssignmentComplete(student.canvasHost, student.canvasToken, {
              id: input.id,
              canvasId: input.id,
            })
          : await markAssignmentIncomplete(student.canvasHost, student.canvasToken, {
              id: input.id,
              canvasId: input.id,
            });
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
        return ok({ file }, { kinds: ["files"], navigate: { view: "class", classId } });
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
      case "open_page": {
        const view = String(input.view || "home").trim().toLowerCase();
        if (!["home", "class", "note"].includes(view)) return fail("view must be home, class, or note.");
        return ok(
          { queued: view },
          { navigate: { view, classId: input.classId || "", noteId: input.noteId || "" } }
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
  return null;
}

export function navigateHref(nav) {
  if (!nav) return "/";
  if (nav.view === "class" && nav.classId) return `/class/${encodeURIComponent(nav.classId)}`;
  if (nav.view === "note" && nav.noteId) return `/note/${encodeURIComponent(nav.noteId)}`;
  return "/";
}
