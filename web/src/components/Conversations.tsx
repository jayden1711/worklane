// Chat conversations and Projects in the Ask panel (src/chat-conversations.ts): a sidebar listing this person's
// conversations (title, last activity; new, rename, delete) and the Projects they can see, the open conversation's
// whole thread, and a Project's editor (name, shared instructions, its files, sharing for owners). Owners and
// writers only; each conversation is its creator's alone, and a Project its creator's until an owner shares it (the
// server enforces all of it). Files are chat attachments (./ChatAttachments.tsx): the same upload, checks and
// downloads. An answer here is the single-shot chat's answer view: drafts and proposals open their own confirm
// flows, and nothing runs from the chat.
import { useEffect, useState, type ReactNode } from 'react';
import { FolderOpen, MessageSquare, Plus, X } from 'lucide-react';
import { deleteConversation, deleteProject, getConversation, getProject, listConversations, listProjects, renameConversation, saveProject, type ChatAttachment, type ChatProject, type ConversationData, type ConversationItem, type ProjectItem } from '../api';
import { ago, Badge, Button, cx } from './ui';
import { ChatAnswerView } from './ChatPanel';
import { AttachButton, AttachmentList, fmtSize, SentAttachments, useAttachments } from './ChatAttachments';

/** Who gets conversations and Projects: the instance's owners and writers (the server refuses anyone else). */
export const mayConverse = (role: string | undefined) => role === 'owner' || role === 'writer';

export type ChatView = { kind: 'quick' } | { kind: 'conversation'; id: string } | { kind: 'project'; id: string | null };

function ConversationRow({ c, project, active, onSelect, onRename, onDelete }: { c: ConversationItem; project?: string | undefined; active: boolean; onSelect: () => void; onRename: (title: string) => void; onDelete: () => void }) {
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
  const [title, setTitle] = useState(c.title);
  if (mode === 'rename')
    return (
      <li className="px-2 py-1.5" data-testid="conv-row" data-id={c.id}>
        <form
          className="flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) onRename(title.trim());
            setMode('view');
          }}
        >
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} aria-label="Conversation title" className="min-w-0 flex-1 rounded-control bg-field px-1.5 text-[12.5px] text-ink shadow-hairline" data-testid="conv-rename-input" />
          <Button size="sm" type="submit" data-testid="conv-rename-save">
            Save
          </Button>
        </form>
      </li>
    );
  return (
    <li className={cx('group px-2 py-1.5', active && 'rounded-control bg-hover-2')} data-testid="conv-row" data-id={c.id} aria-current={active ? 'true' : undefined}>
      <button type="button" onClick={onSelect} className="block w-full min-w-0 text-left" data-testid="conv-open">
        <span className="block truncate text-[12.5px] text-ink" data-testid="conv-title">
          {c.title}
        </span>
        <span className="block text-[11px] text-ink-3" data-testid="conv-activity">
          {ago(c.updatedAt)}
          {project && <span data-testid="conv-project"> · {project}</span>}
        </span>
      </button>
      {mode === 'delete' ? (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11.5px]" data-testid="conv-delete-confirming">
          <span className="text-ink-2">Delete it and everything in it, for good?</span>
          <Button size="sm" variant="danger" onClick={onDelete} data-testid="conv-delete-confirm">
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode('view')} data-testid="conv-delete-cancel">
            Keep
          </Button>
        </div>
      ) : (
        <div className="mt-0.5 flex gap-2 text-[11px] text-ink-3">
          <button type="button" className="hover:text-ink" onClick={() => (setTitle(c.title), setMode('rename'))} data-testid="conv-rename">
            Rename
          </button>
          <button type="button" className="hover:text-red" onClick={() => setMode('delete')} data-testid="conv-delete">
            Delete
          </button>
        </div>
      )}
    </li>
  );
}

/** The sidebar as it renders from its lists (the container below loads them). */
export function ConversationSidebarView({ conversations, projects, view, more, onSelect, onNew, onRename, onDelete, onMore }: { conversations: ConversationItem[]; projects: ProjectItem[]; view: ChatView; more?: boolean; onSelect: (v: ChatView) => void; onNew: (project: string | null) => void; onRename: (id: string, title: string) => void; onDelete: (id: string) => void; onMore?: () => void }) {
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  return (
    <nav className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2" aria-label="Conversations" data-testid="conv-sidebar">
      <div className="flex flex-col gap-1">
        <Button size="sm" onClick={() => onNew(view.kind === 'project' ? view.id : null)} data-testid="conv-new">
          <Plus className="size-3.5" /> New conversation
        </Button>
        <button type="button" onClick={() => onSelect({ kind: 'quick' })} className={cx('rounded-control px-2 py-1 text-left text-[12.5px] text-ink-2 hover:bg-hover-2', view.kind === 'quick' && 'bg-hover-2 text-ink')} data-testid="conv-quick">
          Quick question
        </button>
      </div>
      <section>
        <div className="flex items-center justify-between px-2 text-[11px] font-medium text-ink-3 uppercase">
          Projects
          <button type="button" className="text-ink-3 hover:text-ink" onClick={() => onSelect({ kind: 'project', id: null })} aria-label="New project" data-testid="project-new">
            <Plus className="size-3.5" />
          </button>
        </div>
        {!projects.length && <div className="px-2 py-1 text-[11.5px] text-ink-3">None yet</div>}
        <ul>
          {projects.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onSelect({ kind: 'project', id: p.id })} className={cx('flex w-full items-center gap-1.5 rounded-control px-2 py-1 text-left text-[12.5px] text-ink hover:bg-hover-2', view.kind === 'project' && view.id === p.id && 'bg-hover-2')} data-testid="project-row" data-id={p.id}>
                <FolderOpen className="size-3.5 shrink-0 text-ink-3" />
                <span className="truncate">{p.name}</span>
                {p.shared && <Badge tone="info">shared</Badge>}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <div className="px-2 text-[11px] font-medium text-ink-3 uppercase">Conversations</div>
        {!conversations.length && (
          <div className="px-2 py-1 text-[11.5px] text-ink-3" data-testid="conv-empty">
            None yet. Each one is yours alone.
          </div>
        )}
        <ul>
          {conversations.map((c) => (
            <ConversationRow key={c.id} c={c} project={c.project ? projectName.get(c.project) : undefined} active={view.kind === 'conversation' && view.id === c.id} onSelect={() => onSelect({ kind: 'conversation', id: c.id })} onRename={(t) => onRename(c.id, t)} onDelete={() => onDelete(c.id)} />
          ))}
        </ul>
        {more && (
          <Button size="sm" variant="ghost" onClick={onMore} data-testid="conv-more">
            More
          </Button>
        )}
      </section>
    </nav>
  );
}

/** Loads this person's conversations and Projects (a page at a time) and renders the sidebar. */
export function ConversationSidebar({ instance, view, version, onSelect, onNew, onChanged }: { instance: string | null; view: ChatView; version: number; onSelect: (v: ChatView) => void; onNew: (project: string | null) => void; onChanged: () => void }) {
  const [convs, setConvs] = useState<ConversationItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([listConversations(instance), listProjects(instance)])
      .then(([c, p]) => {
        if (!live) return;
        setConvs(c.items);
        setNext(c.next);
        setProjects(p.items);
        setErr(null);
      })
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [instance, version]);
  const more = () =>
    void listConversations(instance, next)
      .then((c) => (setConvs((prev) => [...prev, ...c.items]), setNext(c.next)))
      .catch((e: Error) => setErr(e.message));
  return (
    <>
      {err && (
        <div className="px-3 py-1 text-[11.5px] text-red" data-testid="conv-error">
          {err}
        </div>
      )}
      <ConversationSidebarView
        conversations={convs}
        projects={projects}
        view={view}
        more={!!next}
        onMore={more}
        onSelect={onSelect}
        onNew={onNew}
        onRename={(id, title) => void renameConversation(instance, id, title).then(onChanged, (e: Error) => setErr(e.message))}
        onDelete={(id) =>
          void deleteConversation(instance, id).then(
            () => {
              if (view.kind === 'conversation' && view.id === id) onSelect({ kind: 'quick' });
              onChanged();
            },
            (e: Error) => setErr(e.message),
          )
        }
      />
    </>
  );
}

/** One conversation's whole thread, as it renders from the server's answer. */
export function ConversationThreadView({ data, cli, instance = null, onOpen = () => {}, onFile = () => Promise.reject(new Error('not here')) }: { data: ConversationData; cli: string; instance?: string | null; onOpen?: (to: string) => void; onFile?: (turn: string) => Promise<number> }) {
  return (
    <div className="space-y-4" data-testid="conv-thread">
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
        <MessageSquare className="size-3.5" />
        <span className="font-medium text-ink" data-testid="conv-thread-title">
          {data.conversation.title}
        </span>
        {data.project && (
          <Badge tone="info">
            <span data-testid="conv-thread-project">{data.project.name}</span>
          </Badge>
        )}
      </div>
      {!data.turns.length && <div className="text-[12.5px] text-ink-3">Ask anything; each answer sees this conversation's earlier turns{data.project ? " and the project's instructions and files" : ''}.</div>}
      {data.turns.map((t) => (
        <div key={t.id} className="space-y-2" data-testid="conv-turn">
          <div className="ml-8 rounded-card bg-inset px-3 py-2 text-[13px] whitespace-pre-wrap text-ink shadow-hairline" data-testid="conv-question">
            {t.text}
            <SentAttachments items={t.attachments} instance={instance} />
          </div>
          <ChatAnswerView f={t} cli={cli} onOpen={onOpen} onFile={() => onFile(t.id)} />
        </div>
      ))}
    </div>
  );
}

/** Loads one conversation (and only it), polling while an answer is pending; `version` reloads it after a send. */
export function ConversationPane({ instance, id, cli, version, onOpen, onFile }: { instance: string | null; id: string; cli: string; version: number; onOpen: (to: string) => void; onFile: (turn: string) => Promise<number> }) {
  const [data, setData] = useState<ConversationData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void getConversation(instance, id).then(
      (d) => live && (setData(d), setErr(null)),
      (e: Error) => live && setErr(e.message),
    );
    return () => {
      live = false;
    };
  }, [instance, id, version, tick]);
  const pending = !!data?.turns.some((t) => t.state === 'pending');
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), 2000);
    return () => window.clearTimeout(timer);
  }, [pending, data]);
  if (err)
    return (
      <div className="text-[12.5px] text-red" data-testid="conv-error">
        {err}
      </div>
    );
  if (!data || data.conversation.id !== id) return <div className="text-[12.5px] text-ink-3">Loading…</div>;
  return <ConversationThreadView data={data} cli={cli} instance={instance} onOpen={onOpen} onFile={onFile} />;
}

/**
 * A Project's editor as it renders: its name, its shared instructions, its files (each removable by its creator; a
 * file taken off is deleted when the Project is saved), new files (`attach`: the upload chips and paperclip), and
 * for an owner, sharing. Someone it was shared with sees it read-only.
 */
export function ProjectEditorView({ project, owner, me, busy, error, attach, ready = [], onSave, onDelete, onNewConversation }: { project: ChatProject | null; owner: boolean; me?: string; busy?: boolean; error?: string | null; attach?: ReactNode; ready?: ChatAttachment[]; onSave: (p: { name: string; instructions: string; files: string[]; shared?: boolean }) => void; onDelete: () => void; onNewConversation: () => void }) {
  const [name, setName] = useState(project?.name ?? '');
  const [instructions, setInstructions] = useState(project?.instructions ?? '');
  const [shared, setShared] = useState(project?.shared ?? false);
  const [files, setFiles] = useState<ChatAttachment[]>(project?.files ?? []);
  const [deleting, setDeleting] = useState(false);
  const mine = !project || !me || project.owner.toLowerCase() === me.toLowerCase();
  return (
    <form
      className="space-y-3"
      data-testid="project-editor"
      onSubmit={(e) => {
        e.preventDefault();
        // Sharing is sent only to turn it on (an owner's) or off (its creator's): a writer never sends `shared: true`.
        onSave({ name: name.trim(), instructions, files: [...files, ...ready].map((f) => f.id), ...(owner || (project?.shared && !shared) ? { shared } : {}) });
      }}
    >
      <div className="text-[13px] font-medium text-ink">{project ? 'Project' : 'New project'}</div>
      {!mine && (
        <div className="text-[12px] text-ink-3" data-testid="project-read-only">
          Shared by @{project!.owner}: you can start your own conversations in it; only they change it.
        </div>
      )}
      <label className="block text-[12px] text-ink-2">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} disabled={!mine} className="mt-1 w-full rounded-control bg-field px-2 py-1.5 text-[13px] text-ink shadow-hairline" data-testid="project-name" />
      </label>
      <label className="block text-[12px] text-ink-2">
        Instructions for every conversation in it
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={8000} rows={6} disabled={!mine} className="mt-1 w-full resize-y rounded-control bg-field px-2 py-1.5 text-[13px] text-ink shadow-hairline" data-testid="project-instructions" />
        <span className="text-[11px] text-ink-3">Given to the chat as data: they shape tone, focus and format, and never override its own rules.</span>
      </label>
      <div className="space-y-1.5 text-[12px] text-ink-2" data-testid="project-files">
        <div>Files {files.length ? `(${files.length})` : ''}</div>
        {!files.length && !ready.length && <div className="text-ink-3">None. Files here are kept while the project holds them.</div>}
        <ul className="flex flex-col gap-1">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-1.5 rounded-control bg-inset px-2 py-1 shadow-hairline" data-testid="project-file">
              <span className="truncate text-ink">{f.name}</span>
              <span className="shrink-0 tabular-nums text-ink-3">{fmtSize(f.size)}</span>
              {mine && (
                <button type="button" onClick={() => setFiles((xs) => xs.filter((x) => x.id !== f.id))} className="primitive-icon-button ml-auto size-5 shrink-0 text-ink-3 hover:bg-hover-2 hover:text-ink" aria-label={`Take ${f.name} off the project`} data-testid="project-file-remove">
                  <X className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
        {mine && attach}
      </div>
      {owner && mine && (
        <label className="flex items-center gap-2 text-[12px] text-ink-2">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} data-testid="project-shared" />
          Share with this instance's owners and writers (their conversations in it stay their own)
        </label>
      )}
      {error && (
        <div className="text-[12px] text-red" data-testid="project-error">
          {error}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {mine && (
          <Button size="sm" type="submit" disabled={busy || !name.trim()} data-testid="project-save">
            {project ? 'Save' : 'Create project'}
          </Button>
        )}
        {project && (
          <Button size="sm" variant="outline" type="button" onClick={onNewConversation} data-testid="project-new-conversation">
            New conversation in it
          </Button>
        )}
        {project && mine && !deleting && (
          <Button size="sm" variant="ghost" type="button" onClick={() => setDeleting(true)} data-testid="project-delete">
            Delete
          </Button>
        )}
        {deleting && (
          <>
            <Button size="sm" variant="danger" type="button" onClick={onDelete} data-testid="project-delete-confirm">
              Delete the project and its files
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setDeleting(false)}>
              Keep
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

/** Loads a Project (or starts a new one), uploads its new files and saves it. */
export function ProjectEditor({ instance, id, role, me, onSaved, onDeleted, onNewConversation }: { instance: string | null; id: string | null; role: string | undefined; me?: string; onSaved: (id: string) => void; onDeleted: () => void; onNewConversation: (project: string) => void }) {
  const [project, setProject] = useState<ChatProject | null>(null);
  const [loaded, setLoaded] = useState(id === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const att = useAttachments({ instance, active: mayConverse(role) });
  useEffect(() => {
    setLoaded(id === null);
    setProject(null);
    att.clear();
    if (!id) return;
    let live = true;
    void getProject(instance, id).then(
      (r) => live && (setProject(r.project), setLoaded(true)),
      (e: Error) => live && (setError(e.message), setLoaded(true)),
    );
    return () => {
      live = false;
    };
  }, [instance, id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!loaded) return <div className="text-[12.5px] text-ink-3">Loading…</div>;
  return (
    <ProjectEditorView
      key={project ? `${project.id}-${project.updatedAt}` : 'new'}
      project={project}
      owner={role === 'owner'}
      {...(me ? { me } : {})}
      busy={busy || att.busy || att.blocked}
      error={error}
      ready={att.ready}
      attach={
        <div className="space-y-1.5">
          <AttachmentList items={att.items} onRemove={att.remove} onAnyway={att.anyway} />
          <AttachButton role={role} {...(att.limits ? { accept: att.limits.extensions } : {})} onFiles={att.add} />
        </div>
      }
      onSave={(p) => {
        setBusy(true);
        void saveProject(instance, project?.id ?? null, p)
          .then((r) => (setProject(r.project), setError(null), att.clear(), onSaved(r.project.id)))
          .catch((e: Error) => setError(e.message))
          .finally(() => setBusy(false));
      }}
      onDelete={() => void deleteProject(instance, project!.id).then(onDeleted, (e: Error) => setError(e.message))}
      onNewConversation={() => onNewConversation(project!.id)}
    />
  );
}
