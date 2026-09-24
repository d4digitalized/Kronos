"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { confirmDialog } from "@/lib/confirm";
import { loadProjectColors } from "@/lib/projectColors";
import { ProjectDot, projectColor } from "@/components/ProjectPicker";
import Avatar, { AVATAR_COLORS } from "@/components/Avatar";
import type { Membership, Project, ProjectCategory } from "@/lib/types";
import { ListSkeleton } from "@/components/Skeletons";

/** Nick pro řazení a popisky: @tag, jinak jméno / e-mail. */
function memberNick(m: Membership): string {
  return (
    m.profiles?.tag_name ||
    m.profiles?.full_name ||
    m.profiles?.email ||
    ""
  ).toLowerCase();
}

export default function ProjectsView({ wsId }: { wsId: string }) {
  const supabase = createClient();
  const [projects, setProjects] = useState<Project[]>([]);
  const [wsMembers, setWsMembers] = useState<Membership[]>([]);
  // členové jednotlivých projektů — kolečka v řádku
  const [memberIds, setMemberIds] = useState<Record<string, string[]>>({});
  // kategorie firmy (Development, Real estate…) + jejich správa
  const [categories, setCategories] = useState<ProjectCategory[]>([]);
  const [catsOpen, setCatsOpen] = useState(false);
  const [newCat, setNewCat] = useState("");
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [loading, setLoading] = useState(true);
  // rozbalená správa členů projektu
  const [membersFor, setMembersFor] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [assignedLoading, setAssignedLoading] = useState(false);
  // rychlé přepnutí projektu: pozdní odpověď předchozího nesmí přepsat členy
  // právě otevřeného (zaškrtávání by pak přidávalo/odebíralo podle špatné sady)
  const membersSeq = useRef(0);
  // Enter dvakrát = dva projekty
  const adding = useRef(false);

  const load = useCallback(async () => {
    const [projectsRes, membersRes, pmRes, catRes] = await Promise.all([
      supabase
        .from("projects")
        .select("*")
        .eq("workspace_id", wsId)
        .order("archived")
        .order("position")
        .order("name"),
      supabase
        .from("workspace_members")
        .select(
          "workspace_id, user_id, role, profiles(full_name, email, tag_name, avatar_initials, avatar_color)"
        )
        .eq("workspace_id", wsId),
      supabase
        .from("project_members")
        .select("project_id, user_id, projects!inner(workspace_id)")
        .eq("projects.workspace_id", wsId),
      supabase
        .from("project_categories")
        .select("*")
        .eq("workspace_id", wsId)
        .order("position")
        .order("name"),
    ]);
    setProjects((projectsRes.data as Project[]) ?? []);
    setCategories((catRes.data as ProjectCategory[]) ?? []);
    // tečky projektů dědí barvu kategorie — po každé změně je přepočítat
    loadProjectColors(supabase, wsId);
    const byProject: Record<string, string[]> = {};
    for (const row of pmRes.data ?? []) {
      byProject[row.project_id as string] = [
        ...(byProject[row.project_id as string] ?? []),
        row.user_id as string,
      ];
    }
    setMemberIds(byProject);
    const members = (membersRes.data as unknown as Membership[]) ?? [];
    members.sort((a, b) => memberNick(a).localeCompare(memberNick(b), "cs"));
    setWsMembers(members);
    setLoading(false);
  }, [supabase, wsId]);

  useEffect(() => {
    load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name || adding.current) return;
    adding.current = true;
    setNewName("");
    const { error } = await supabase.from("projects").insert({
      workspace_id: wsId,
      name,
      position: Math.max(0, ...projects.map((p) => p.position)) + 1,
    });
    adding.current = false;
    if (error) {
      setNewName(name);
      toast("Projekt se nepodařilo založit.", "error");
      return;
    }
    load();
  }

  /** Posun v rámci stejné skupiny (aktivní/archivované): prohodí position. */
  async function move(project: Project, dir: -1 | 1) {
    const group = projects.filter((p) => p.archived === project.archived);
    const idx = group.findIndex((p) => p.id === project.id);
    const other = group[idx + dir];
    if (!other) return;
    setProjects((prev) =>
      prev.map((p) =>
        p.id === project.id
          ? { ...p, position: other.position }
          : p.id === other.id
            ? { ...p, position: project.position }
            : p
      ).sort((a, b) =>
        Number(a.archived) - Number(b.archived) ||
        a.position - b.position ||
        a.name.localeCompare(b.name, "cs", { numeric: true })
      )
    );
    const [r1, r2] = await Promise.all([
      supabase.from("projects").update({ position: other.position }).eq("id", project.id),
      supabase.from("projects").update({ position: project.position }).eq("id", other.id),
    ]);
    if (r1.error || r2.error) {
      toast("Změna pořadí se nezdařila.", "error");
      load();
    }
  }

  /** Přerovná projekty podle názvu a pořadí uloží (position) — projeví se
      všude, kde se projekty řadí: nástěnky, pickery, Přehledy. Číselné
      prefixy se řadí přirozeně (2000_ před 3105_). */
  async function sortByName() {
    const collator = new Intl.Collator("cs", { numeric: true });
    const ordered = [...projects].sort(
      (a, b) => Number(a.archived) - Number(b.archived) || collator.compare(a.name, b.name)
    );
    setProjects(ordered.map((p, i) => ({ ...p, position: i + 1 })));
    const results = await Promise.all(
      ordered.map((p, i) =>
        supabase.from("projects").update({ position: i + 1 }).eq("id", p.id)
      )
    );
    if (results.some((r) => r.error)) {
      toast("Seřazení se nezdařilo.", "error");
      load();
      return;
    }
    toast("Projekty seřazeny podle názvu.");
  }

  // ------------------------------------------------------------- kategorie

  async function addCategory(e: React.FormEvent) {
    e.preventDefault();
    const name = newCat.trim();
    if (!name) return;
    const { error } = await supabase.from("project_categories").insert({
      workspace_id: wsId,
      name,
      color: AVATAR_COLORS[categories.length % AVATAR_COLORS.length],
      position: categories.length + 1,
    });
    if (error) {
      toast("Kategorii se nepodařilo založit.", "error");
      return;
    }
    setNewCat("");
    load();
  }

  async function renameCategory(cat: ProjectCategory, name: string) {
    const next = name.trim();
    if (!next || next === cat.name) return;
    const { error } = await supabase
      .from("project_categories")
      .update({ name: next })
      .eq("id", cat.id);
    if (error) toast("Přejmenování kategorie se nezdařilo.", "error");
    load();
  }

  async function setCategoryColor(cat: ProjectCategory, color: string) {
    setCategories((prev) =>
      prev.map((c) => (c.id === cat.id ? { ...c, color } : c))
    );
    const { error } = await supabase
      .from("project_categories")
      .update({ color })
      .eq("id", cat.id);
    if (error) {
      toast("Změna barvy se nezdařila.", "error");
      load();
      return;
    }
    loadProjectColors(supabase, wsId); // přebarvi tečky projektů v kategorii
  }

  /** Posun kategorie v pořadí — prohodí position se sousedem. */
  async function moveCategory(cat: ProjectCategory, dir: -1 | 1) {
    const idx = categories.findIndex((c) => c.id === cat.id);
    const other = categories[idx + dir];
    if (!other) return;
    setCategories((prev) => {
      const next = [...prev];
      next[idx] = other;
      next[idx + dir] = cat;
      return next;
    });
    // pozice mohou po ruční editaci kolidovat — zapiš rovnou indexy obou
    const [r1, r2] = await Promise.all([
      supabase
        .from("project_categories")
        .update({ position: idx + dir + 1 })
        .eq("id", cat.id),
      supabase
        .from("project_categories")
        .update({ position: idx + 1 })
        .eq("id", other.id),
    ]);
    if (r1.error || r2.error) {
      toast("Změna pořadí kategorií se nezdařila.", "error");
      load();
    }
  }

  async function removeCategory(cat: ProjectCategory) {
    const used = projects.filter((p) => p.category_id === cat.id).length;
    const ok = await confirmDialog({
      title: "Smazat kategorii?",
      message: used
        ? `Kategorie „${cat.name}" se smaže; ${used} projektů zůstane bez zařazení.`
        : `Kategorie „${cat.name}" se smaže.`,
      confirmLabel: "Smazat",
    });
    if (!ok) return;
    const { error } = await supabase
      .from("project_categories")
      .delete()
      .eq("id", cat.id);
    if (error) toast("Smazání kategorie se nezdařilo.", "error");
    load();
  }

  /** Zařazení projektu do kategorie (select v řádku). */
  async function setProjectCategory(project: Project, categoryId: string | null) {
    setProjects((prev) =>
      prev.map((p) => (p.id === project.id ? { ...p, category_id: categoryId } : p))
    );
    const { error } = await supabase
      .from("projects")
      .update({ category_id: categoryId })
      .eq("id", project.id);
    if (error) {
      toast("Změna kategorie se nezdařila.", "error");
      load();
      return;
    }
    loadProjectColors(supabase, wsId); // tečka projektu převezme barvu kategorie
  }

  async function rename(project: Project) {
    if (editName.trim() && editName.trim() !== project.name) {
      await supabase.from("projects").update({ name: editName.trim() }).eq("id", project.id);
    }
    setEditingId(null);
    load();
  }

  async function toggleArchive(project: Project) {
    await supabase
      .from("projects")
      .update({ archived: !project.archived })
      .eq("id", project.id);
    load();
  }

  async function openMembers(project: Project) {
    if (membersFor === project.id) {
      setMembersFor(null);
      return;
    }
    const seq = ++membersSeq.current;
    setMembersFor(project.id);
    setAssignedLoading(true);
    const { data, error } = await supabase
      .from("project_members")
      .select("user_id")
      .eq("project_id", project.id);
    if (seq !== membersSeq.current) return;
    if (error) {
      toast("Členy projektu se nepodařilo načíst.", "error");
      setMembersFor(null);
      setAssignedLoading(false);
      return;
    }
    setAssigned(new Set((data ?? []).map((r) => r.user_id as string)));
    setAssignedLoading(false);
  }

  async function toggleMember(projectId: string, userId: string) {
    const wasOn = assigned.has(userId);
    setAssigned((prev) => {
      const next = new Set(prev);
      if (wasOn) next.delete(userId);
      else next.add(userId);
      return next;
    });
    // kolečka v řádku ať se překreslí hned
    setMemberIds((prev) => ({
      ...prev,
      [projectId]: wasOn
        ? (prev[projectId] ?? []).filter((id) => id !== userId)
        : [...(prev[projectId] ?? []), userId],
    }));
    const { error } = wasOn
      ? await supabase
          .from("project_members")
          .delete()
          .eq("project_id", projectId)
          .eq("user_id", userId)
      : await supabase
          .from("project_members")
          .insert({ project_id: projectId, user_id: userId });
    if (error) {
      setAssigned((prev) => {
        const next = new Set(prev);
        if (wasOn) next.add(userId);
        else next.delete(userId);
        return next;
      });
      setMemberIds((prev) => ({
        ...prev,
        [projectId]: wasOn
          ? [...(prev[projectId] ?? []), userId]
          : (prev[projectId] ?? []).filter((id) => id !== userId),
      }));
      toast("Změna členství se nezdařila.", "error");
    }
  }

  if (loading) return <ListSkeleton />;

  return (
    <div className="space-y-4">
      <form
        onSubmit={add}
        className="flex gap-2 panel p-3"
      >
        <input
          type="text"
          placeholder="Nový projekt…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className="flex-1 input"
        />
        <button
          type="submit"
          className="btn-primary"
        >
          Přidat
        </button>
        {projects.length > 1 && (
          <button
            type="button"
            onClick={sortByName}
            title="Přerovná projekty abecedně (číselné prefixy vzestupně) a pořadí uloží"
            className="btn-ghost whitespace-nowrap px-3 text-sm"
          >
            Seřadit podle názvu
          </button>
        )}
      </form>

      {/* kategorie projektů — vlastní sada za firmu, filtrují se podle nich
          projekty na rozcestníku */}
      <div className="panel">
        <button
          onClick={() => setCatsOpen((o) => !o)}
          aria-expanded={catsOpen}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        >
          <span className="text-sm font-medium">Kategorie projektů</span>
          <span className="text-xs text-ink-soft/70">
            {categories.length === 0
              ? "žádné — projekty se nefiltrují"
              : `${categories.length} · ${categories.map((c) => c.name).join(", ")} — pořadí řídí šipky`}
          </span>
          <span className="flex-1" />
          <span className="text-xs text-ink-soft/50" aria-hidden>
            {catsOpen ? "▴" : "▾"}
          </span>
        </button>
        {catsOpen && (
          <div className="space-y-2 border-t border-line/50 bg-black/[.015] px-3 py-3">
            {categories.map((cat, i) => (
              <div key={cat.id} className="flex flex-wrap items-center gap-2">
                <span className="flex flex-col">
                  <button
                    onClick={() => moveCategory(cat, -1)}
                    disabled={i === 0}
                    aria-label={`Posunout ${cat.name} nahoru`}
                    className="rounded px-1 text-[10px] leading-3 text-ink-soft/50 hover:bg-black/5 hover:text-ink disabled:opacity-30"
                  >
                    ▲
                  </button>
                  <button
                    onClick={() => moveCategory(cat, 1)}
                    disabled={i === categories.length - 1}
                    aria-label={`Posunout ${cat.name} dolů`}
                    className="rounded px-1 text-[10px] leading-3 text-ink-soft/50 hover:bg-black/5 hover:text-ink disabled:opacity-30"
                  >
                    ▼
                  </button>
                </span>
                <span
                  aria-hidden
                  style={{ background: cat.color || projectColor(cat.id) }}
                  className="h-3 w-3 shrink-0 rounded-full"
                />
                <input
                  type="text"
                  defaultValue={cat.name}
                  onBlur={(e) => renameCategory(cat, e.target.value)}
                  aria-label={`Název kategorie ${cat.name}`}
                  className="input min-w-40 flex-1 px-2 py-1 text-sm"
                />
                <span className="flex flex-wrap items-center gap-1">
                  {AVATAR_COLORS.map((color) => (
                    <button
                      key={color}
                      onClick={() => setCategoryColor(cat, color)}
                      aria-label={`Barva ${color}`}
                      aria-pressed={cat.color === color}
                      style={{ background: color }}
                      className={`h-5 w-5 rounded-full transition-transform ${
                        cat.color === color
                          ? "scale-110 ring-2 ring-ink ring-offset-1"
                          : "hover:scale-105"
                      }`}
                    />
                  ))}
                </span>
                <span className="text-xs text-ink-soft/60">
                  {projects.filter((p) => p.category_id === cat.id).length} projektů
                </span>
                <button
                  onClick={() => removeCategory(cat)}
                  className="rounded-md px-2 py-1 text-xs text-danger hover:bg-danger/10"
                >
                  Smazat
                </button>
              </div>
            ))}
            <form onSubmit={addCategory} className="flex gap-2 pt-1">
              <input
                type="text"
                placeholder="Nová kategorie (např. Development)…"
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                className="input min-w-40 flex-1 px-2 py-1 text-sm"
              />
              <button type="submit" className="btn-primary px-3 py-1 text-xs">
                Přidat
              </button>
            </form>
          </div>
        )}
      </div>

      <div className="divide-y divide-line/70 panel">
        {projects.length === 0 && (
          <p className="p-4 text-sm text-ink-soft/70">Zatím žádné projekty.</p>
        )}
        {projects.map((project) => (
          <div key={project.id}>
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="flex flex-col">
                <button
                  onClick={() => move(project, -1)}
                  aria-label={`Posunout ${project.name} nahoru`}
                  className="rounded px-1 text-[10px] leading-3 text-ink-soft/50 hover:bg-black/5 hover:text-ink"
                >
                  ▲
                </button>
                <button
                  onClick={() => move(project, 1)}
                  aria-label={`Posunout ${project.name} dolů`}
                  className="rounded px-1 text-[10px] leading-3 text-ink-soft/50 hover:bg-black/5 hover:text-ink"
                >
                  ▼
                </button>
              </span>
              <ProjectDot id={project.id} />
              {editingId === project.id ? (
                <>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="flex-1 input px-2 py-1"
                    autoFocus
                  />
                  <button
                    onClick={() => rename(project)}
                    className="btn-primary px-2 py-1 text-xs"
                  >
                    Uložit
                  </button>
                </>
              ) : (
                <>
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${project.archived ? "text-ink-soft/70 line-through" : ""}`}
                  >
                    {project.name}
                  </span>
                  {/* přiřazení členové (bez adminů — ti vidí všechny projekty),
                      seřazení podle nicku */}
                  {(() => {
                    const people = (memberIds[project.id] ?? [])
                      .map((id) => wsMembers.find((x) => x.user_id === id))
                      .filter((m): m is Membership => !!m && m.role !== "admin")
                      .sort((a, b) => memberNick(a).localeCompare(memberNick(b), "cs"));
                    if (people.length === 0) return null;
                    return (
                      <span className="flex shrink-0 items-center gap-1">
                        {people.map((m) => (
                          <Avatar
                            key={m.user_id}
                            profile={m.profiles}
                            colorKey={m.user_id}
                            size="sm"
                          />
                        ))}
                      </span>
                    );
                  })()}
                  {/* zařazení do kategorie firmy */}
                  {categories.length > 0 && (
                    <select
                      value={project.category_id ?? ""}
                      onChange={(e) =>
                        setProjectCategory(project, e.target.value || null)
                      }
                      aria-label={`Kategorie projektu ${project.name}`}
                      style={{
                        color: project.category_id
                          ? (categories.find((c) => c.id === project.category_id)
                              ?.color || undefined)
                          : undefined,
                      }}
                      className="input shrink-0 px-1.5 py-1 text-xs"
                    >
                      <option value="">— bez kategorie —</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    onClick={() => openMembers(project)}
                    aria-expanded={membersFor === project.id}
                    className={`rounded-md px-2 py-1 text-xs hover:bg-black/5 ${
                      membersFor === project.id
                        ? "bg-accent-soft text-accent"
                        : "text-ink-soft"
                    }`}
                  >
                    Členové
                  </button>
                  <button
                    onClick={() => {
                      setEditingId(project.id);
                      setEditName(project.name);
                    }}
                    className="rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-black/5"
                  >
                    Přejmenovat
                  </button>
                  <button
                    onClick={() => toggleArchive(project)}
                    className="rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-black/5"
                  >
                    {project.archived ? "Obnovit" : "Archivovat"}
                  </button>
                </>
              )}
            </div>
            {membersFor === project.id && (
              <div className="border-t border-line/50 bg-black/[.015] px-3 py-2">
                <p className="pb-1 text-xs text-ink-soft/70">
                  Kdo projekt vidí a pracuje na něm. V řádku projektu jsou
                  kolečka přiřazených členů; admini mají přístup ke všem
                  projektům automaticky, proto se tam neukazují.
                </p>
                {assignedLoading ? (
                  <p className="py-1 text-sm text-ink-soft/70">Načítám…</p>
                ) : (
                  <div className="grid gap-x-6 sm:grid-cols-2">
                    {wsMembers.map((member) => {
                      const name = member.profiles?.tag_name
                        ? `@${member.profiles.tag_name}`
                        : member.profiles?.full_name ||
                          member.profiles?.email ||
                          "?";
                      if (member.role === "admin") {
                        return (
                          <div
                            key={member.user_id}
                            className="flex items-center gap-2 py-1 text-sm text-ink-soft"
                          >
                            <span className="inline-flex h-4 w-4 items-center justify-center">
                              ✓
                            </span>
                            <Avatar
                              profile={member.profiles}
                              colorKey={member.user_id}
                              size="xs"
                            />
                            <span className="truncate">{name}</span>
                            <span className="shrink-0 text-xs text-ink-soft/60">
                              — admin, vidí vše
                            </span>
                          </div>
                        );
                      }
                      return (
                        <label
                          key={member.user_id}
                          className="flex cursor-pointer items-center gap-2 py-1 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={assigned.has(member.user_id)}
                            onChange={() => toggleMember(project.id, member.user_id)}
                            className="h-4 w-4 accent-[var(--accent)]"
                          />
                          <Avatar
                            profile={member.profiles}
                            colorKey={member.user_id}
                            size="xs"
                          />
                          <span className="min-w-0 flex-1 truncate">{name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
