"use client";

import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { priorityColor } from "@/lib/priority";
import { dayKey } from "@/lib/format";
import { projectColor } from "@/components/ProjectPicker";
import Avatar from "@/components/Avatar";
import type { Label, Membership, Task } from "@/lib/types";

function BoardCard({
  task,
  members,
  labels = [],
  assigneeIds = [],
  subtaskCount,
  waitingOn,
  ghostAssignees = [],
  onOpen,
  onStart,
}: {
  task: Task;
  members: Membership[];
  labels?: Label[];
  assigneeIds?: string[];
  subtaskCount?: { done: number; total: number };
  /** jméno člověka, na kterého karta čeká (follow-up) */
  waitingOn?: string;
  /** duší řešitelé — kontakty bez účtu */
  ghostAssignees?: {
    id: string;
    name: string;
    avatar_initials?: string;
    avatar_color?: string;
  }[];
  onOpen: (task: Task) => void;
  onStart: (task: Task) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id, data: { type: "card" } });

  const isDone = !!task.completed_at;
  // místní dnešek — UTC datum by mezi půlnocí a 2:00 bylo ještě včerejší
  const overdue =
    !isDone && task.due_date && task.due_date < dayKey(new Date().toISOString());
  const assignees = assigneeIds
    .map((id) => members.find((m) => m.user_id === id))
    .filter((m): m is Membership => !!m);
  const flag = priorityColor(task.priority ?? 4);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(flag ? { borderLeft: `3px solid ${flag}` } : {}),
      }}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(task)}
      className={`cursor-grab rounded-lg border border-line bg-surface p-2 shadow-sm hover:border-accent/50 ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <p className={`text-sm ${isDone ? "text-ink-soft/70 line-through" : ""}`}>
        {task.title}
        {task.recurrence && (
          <span className="ml-1 text-xs text-ink-soft/50" title="Opakovaná karta">
            ↻
          </span>
        )}
        {task.is_private && (
          <span
            className="ml-1 text-xs text-ink-soft/50"
            title="Skrytý úkol — vidíš ho jen ty"
          >
            🔒
          </span>
        )}
      </p>
      {waitingOn && !isDone && (
        <span
          className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-medium text-amber-800"
          title={waitingOn === "—" ? "Čeká na dodání" : `Čeká na dodání: ${waitingOn}`}
        >
          {/* „—" = follow-up bez určené osoby */}
          ⏳ {waitingOn === "—" ? "čeká" : `čeká na ${waitingOn}`}
        </span>
      )}
      {labels.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {labels.map((label) => (
            <span
              key={label.id}
              className="rounded-full px-1.5 py-px text-[10px] font-medium text-white"
              style={{ background: projectColor(label.id) }}
            >
              {label.name}
            </span>
          ))}
        </div>
      )}
      {(task.due_date ||
        assignees.length > 0 ||
        ghostAssignees.length > 0 ||
        subtaskCount ||
        !isDone) && (
        <div className="mt-1.5 flex items-center gap-2">
          {task.due_date && (
            <span
              className={`text-xs ${overdue ? "font-medium text-red-600" : "text-ink-soft/70"}`}
            >
              {new Date(task.due_date).toLocaleDateString("cs-CZ", {
                day: "numeric",
                month: "numeric",
              })}
            </span>
          )}
          {subtaskCount && subtaskCount.total > 0 && (
            <span
              className={`text-xs ${
                subtaskCount.done === subtaskCount.total
                  ? "text-accent"
                  : "text-ink-soft/70"
              }`}
              title="Podúkoly"
            >
              ☑ {subtaskCount.done}/{subtaskCount.total}
            </span>
          )}
          {task.description && <span className="text-xs text-ink-soft/50">≡</span>}
          <span className="flex-1" />
          {(assignees.length > 0 || ghostAssignees.length > 0) && (
            <span className="flex -space-x-1.5">
              {assignees.slice(0, 3).map((m) => (
                <Avatar
                  key={m.user_id}
                  profile={m.profiles}
                  colorKey={m.user_id}
                  size="sm"
                  className="border border-surface"
                />
              ))}
              {ghostAssignees.slice(0, Math.max(0, 3 - assignees.length)).map((g) =>
                g.avatar_initials || g.avatar_color ? (
                  <Avatar
                    key={g.id}
                    profile={{
                      full_name: g.name,
                      avatar_initials: g.avatar_initials || null,
                      avatar_color: g.avatar_color || "#9ca3af",
                    }}
                    colorKey={g.id}
                    size="sm"
                    className="border border-surface"
                  />
                ) : (
                  <span
                    key={g.id}
                    title={`${g.name} (duch)`}
                    className="flex h-5 w-5 items-center justify-center rounded-full border border-surface bg-black/10 text-[10px]"
                  >
                    👻
                  </span>
                )
              )}
              {assignees.length + ghostAssignees.length > 3 && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full border border-surface bg-black/10 text-[9px] font-medium text-ink-soft">
                  +{assignees.length + ghostAssignees.length - 3}
                </span>
              )}
            </span>
          )}
          {!isDone && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onStart(task);
              }}
              aria-label={`Spustit timer na kartě ${task.title}`}
              title="Spustit timer"
              className="rounded px-1 text-xs text-ink-soft/70 hover:bg-accent-soft hover:text-accent"
            >
              ▶
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// memo: karta se překreslí jen při změně vlastních props (ne při psaní do
// filtru nebo tiknutí timeru jinde). Callbacky drží BoardView přes useCallback.
export default memo(BoardCard);
