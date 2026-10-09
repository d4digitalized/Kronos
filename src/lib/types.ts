export type Role = "admin" | "member";

export type Profile = {
  id: string;
  email: string;
  full_name: string;
  is_super_admin: boolean;
  /** 1–3 písmena; prázdné = odvodit ze jména */
  avatar_initials?: string;
  /** #rrggbb; prázdné = odvodit z id */
  avatar_color?: string;
  /** @handle bez zavináče, unikátní; nastavuje admin */
  tag_name?: string;
};

export type Workspace = {
  id: string;
  name: string;
};

/** Workspace i s mými oprávněními v něm — přepínač v „Nový úkol" podle nich
    rozhoduje, zda ukázat „Čekám na" a „Skrytý". */
export type WorkspaceOption = Workspace & {
  canDelegate: boolean;
  canHide: boolean;
};

export type Membership = {
  workspace_id: string;
  user_id: string;
  role: Role;
  /** per-firma notifikační e-mail; prázdný = účetní e-mail. Nastavuje admin. */
  notify_email?: string;
  /** e-mailové notifikace z této firmy; vypíná/zapíná admin. */
  notify_enabled?: boolean;
  /** odemknutá delegace („Čekám na", Delegované); adminům dána vždy. Nastavuje admin. */
  can_delegate?: boolean;
  /** odemknuté skryté úkoly (is_private); adminům dáno vždy. Nastavuje admin. */
  can_hide?: boolean;
  /** HR: vidí a exportuje výkazy lidí z hr_grants; adminům dáno vždy. Nastavuje admin. */
  can_hr?: boolean;
  /** osobní poznámky v Masteru; default vypnuto všem. Nastavuje admin. */
  can_notes?: boolean;
  /** „jen měření času" — osekané rozhraní: pouze timer a Report. Nastavuje admin. */
  time_only?: boolean;
  /** denní výkaz v % (8h den) místo timeru; zahrnuje osekané rozhraní. Nastavuje admin. */
  percent_report?: boolean;
  workspaces?: Workspace;
  profiles?: Profile;
};

export type Project = {
  id: string;
  workspace_id: string;
  name: string;
  archived: boolean;
  position: number;
  /** zařazení do kategorie firmy; null = bez kategorie */
  category_id?: string | null;
};

/** Kategorie projektů — vlastní sada za každou firmu (spravuje admin). */
export type ProjectCategory = {
  id: string;
  workspace_id: string;
  name: string;
  /** hex barva; prázdné = odvodí se z id */
  color: string;
  position: number;
};

export type BoardColumn = {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  position: number;
};

export type Recurrence = "daily" | "weekdays" | "weekly" | "monthly" | "yearly";

export type Task = {
  id: string;
  workspace_id: string;
  /** null = soukromý úkol bez projektu (vidí ho autor + řešitelé + admin) */
  project_id: string | null;
  column_id: string | null;
  position: number;
  title: string;
  description: string;
  /** legacy — řešitele nese tabulka task_assignees */
  assignee_id: string | null;
  due_date: string | null;
  completed_at: string | null;
  created_by: string;
  created_at: string;
  priority: number;
  parent_id: string | null;
  recurrence: Recurrence | null;
  /** skrytý úkol — vidí ho jen autor (ani admin ne) */
  is_private?: boolean;
  /** vedoucí úkolu (interní člen); nastavuje jen admin */
  lead_id?: string | null;
  /** uspaná karta (sloupec Hold) — vidět jen na nástěnce projektu */
  on_hold?: boolean;
  /** plánované okno práce — propisuje se do kalendáře „Kronos" řešitelů */
  planned_start?: string | null;
  planned_end?: string | null;
  /** potvrzené roztřídění v Inboxu („Utříděno ✓"); null = ještě v Inboxu */
  triaged_at?: string | null;
  projects?: { name: string; position?: number };
  board_columns?: { name: string } | null;
};

export type Label = {
  id: string;
  workspace_id: string;
  name: string;
};

/** Externí člověk bez účtu — jen evidence, sdílená za workspace. */
export type Contact = {
  id: string;
  workspace_id: string;
  name: string;
  email: string;
  note: string;
  /** vlastní iniciály/barva avataru; prázdné = šedé kolečko dle jména */
  avatar_initials?: string;
  avatar_color?: string;
  created_by: string | null;
  created_at: string;
};

/** Čekání na dodání úkolu (GTD „Waiting For"); právě jeden z user/contact. */
export type TaskFollowup = {
  task_id: string;
  workspace_id: string;
  waiting_user_id: string | null;
  waiting_contact_id: string | null;
  /** od kdy čekám (editovatelné; default den vzniku) */
  waiting_since?: string;
  /** do kdy slíbil/a dodat — slíbený termín, ne termín úkolu (tasks.due_date) */
  waiting_until?: string | null;
  created_by: string;
  created_at: string;
  contacts?: { name: string } | null;
  tasks?: Task;
};

export type AppNotification = {
  id: string;
  user_id: string;
  kind: "assigned" | "comment" | "mention";
  workspace_id: string;
  project_id: string | null;
  task_id: string | null;
  task_title: string;
  actor_name: string;
  body: string;
  created_at: string;
  read_at: string | null;
};

export type NotificationPrefs = {
  user_id: string;
  on_assign: boolean;
  on_comment: boolean;
  on_mention: boolean;
  daily_digest: boolean;
};

export type TaskComment = {
  id: string;
  workspace_id: string;
  task_id: string;
  author_id: string;
  body: string;
  created_at: string;
  profiles?: {
    full_name: string;
    email: string;
    avatar_initials?: string | null;
    avatar_color?: string | null;
  };
};

export type TaskAttachment = {
  id: string;
  workspace_id: string;
  task_id: string;
  uploaded_by: string | null;
  file_name: string;
  object_path: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

export type Checklist = {
  id: string;
  workspace_id: string;
  task_id: string;
  title: string;
  position: number;
  created_at: string;
};

export type ChecklistItem = {
  id: string;
  checklist_id: string;
  content: string;
  completed_at: string | null;
  position: number;
  created_at: string;
};

export type TaskActivityKind =
  | "created"
  | "moved_column"
  | "moved_project"
  | "due_changed"
  | "priority_changed"
  | "completed"
  | "reopened"
  | "assigned"
  | "unassigned"
  | "followup_set"
  | "followup_cleared"
  | "lead_changed";

export type TaskActivity = {
  id: string;
  workspace_id: string;
  task_id: string;
  actor_id: string | null;
  kind: TaskActivityKind;
  meta: Record<string, unknown>;
  created_at: string;
  profiles?: { full_name: string; email: string } | null;
};

/** Štítek vyúčtovaných hodin z TEKTOSu (0052) — RLS ho vrací jen adminům firmy. */
export type TimeEntryBilling = {
  billing_number: string;
  billing_status: "issued" | "paid";
  billing_url: string | null;
};

export type TimeEntry = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  task_id: string | null;
  user_id: string;
  description: string;
  started_at: string;
  stopped_at: string | null;
  tasks?: { title: string } | null;
  projects?: { name: string; position?: number } | null;
  profiles?: {
    full_name: string;
    email: string;
    avatar_initials?: string;
    avatar_color?: string;
  };
  /** jen pro adminy (RLS), ostatním null; PostgREST může vrátit i pole */
  time_entry_billings?: TimeEntryBilling | TimeEntryBilling[] | null;
};
