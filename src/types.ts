/** The shapes the modules pass between each other. */

export interface Project {
  name: string;
  path: string;
}

/**
 * Conversation memory is the Claude CLI's own session, one per project.
 *
 * Earlier this file kept the last few messages in memory and pasted them into
 * each prompt, which lost everything on restart and gave Claude a transcript
 * rather than a conversation. Resuming a real session keeps the whole history —
 * including what Claude read and did — and the CLI manages its own context.
 * The ids live on disk so a restart continues where the conversation left off.

 */
export interface SessionEntry {
  id: string;
  fork?: boolean;
  /** Display name to stamp on the fork, so the IDE's picker can tell them apart. */
  name?: string;
  /**
   * Handed over to another window: remembered, but not resumed.
   *
   * Two windows appending to one transcript do not corrupt it — they grow a
   * second branch from the same parent, and the next run silently follows one
   * of them, so the other window's work stops existing as far as the
   * conversation is concerned. Parking is how a session is handed over without
   * that: the bridge keeps the id but stops writing into it.
   *
   * There is one kind: the idle timer letting go of a conversation nobody is
   * having any more. The next message takes it back — the same session,
   * continued, not a copy. A `/handoff` command once parked a session that
   * waited for a button instead; the idle window made it pointless, and older
   * files storing `'manual'` or `true` are read back as this.
   */
  parked?: 'auto';
  /**
   * What the transcript looked like when it was parked.
   *
   * Only so that taking it back can mention the desk having moved it on — the
   * session is continued either way.
   */
  stamp?: string;
}


/**
 * A "tab" is one Telegram forum topic — or the private chat, which is one tab.
 *
 * Each tab keeps its own selected project and its own conversation, so two
 * topics are two independent workstreams the way two Claude Code tabs are.
 * State is keyed by chat + topic and persisted, so restarts don't reshuffle it.
 */
export interface Tab {
  key: string;
  label: string;
  project: Project;
  /**
   * True while the tab has never been pointed at a project of its own.
   *
   * Every tab falls back to the project hosting the bridge, so a group of
   * topics named after different repositories all answer about the same one
   * until each is set. That looked like the session list ignoring topics; it
   * was three tabs genuinely on one project, so the state is worth showing.
   */
  implicit: boolean;
}


export interface ClaudeRun {
  result: string;
  sessionId?: string;
  isError: boolean;
  stderr: string;
  code: number | null;
}
