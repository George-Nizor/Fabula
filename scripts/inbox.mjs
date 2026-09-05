// The window's messages to the agent: a choice made on an insert point, a
// request in words for something else, a question. The window appends;
// wait_for_input takes what is there and files it under inbox-seen.json so
// nothing is answered twice. Both sides write whole files atomically.

import fs from "node:fs";
import path from "node:path";

const INBOX = "inbox.json";
const SEEN = "inbox-seen.json";

function readList(file) {
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeList(file, list) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
}

export function appendInbox(dir, event) {
  const file = path.join(dir, INBOX);
  const list = readList(file);
  const record = { id: `evt-${Date.now().toString(36)}-${list.length}`, at: new Date().toISOString(), ...event };
  list.push(record);
  writeList(file, list);
  return record;
}

export function pendingInbox(dir) {
  return readList(path.join(dir, INBOX));
}

// Takes every pending event: returned to the caller, moved to the seen file.
export function takeInbox(dir) {
  const file = path.join(dir, INBOX);
  const list = readList(file);
  if (list.length === 0) return [];
  const seenFile = path.join(dir, SEEN);
  writeList(seenFile, [...readList(seenFile), ...list].slice(-200));
  writeList(file, []);
  return list;
}
