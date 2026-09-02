/** Mirrors the view models the server produces in `apps/server/src/view.ts`. */

export type Tier = "conceptual" | "logical" | "physical";
export type Severity = "error" | "warning" | "info";

export interface MemberView {
  name: string;
  /** Dotted path from the object root, e.g. `address.postcode`. Edits address by path. */
  path: string;
  type: string;
  required: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  description?: string;
  depth: number;
  classification?: string;
}

export interface NodeView {
  id: string;
  name: string;
  kind: string;
  subjectArea?: string;
  layer?: string;
  description?: string;
  members: MemberView[];
  x: number;
  y: number;
  positioned: boolean;
  /** Estimated size, so edges can route before the browser measures the node. */
  width: number;
  height: number;
  /** True when the user resized this box, so the size is intentional rather than estimated. */
  userSized: boolean;
  /**
   * `entity` / `associative` / `weak` / `supertype` / `subtype`, on logical entities only.
   *
   * IDEF1X draws an identifier-dependent entity, `weak` or `associative`, with rounded
   * corners, so this is what tells the canvas which boxes those are. Absent on tables and
   * concepts, which have no equivalent notion.
   */
  entityType?: string;
  /** Supertype this entity specialises, for an IDEF1X subtype cluster. */
  supertype?: string;
  /** Whether a supertype's subtypes are exhaustive. Drives the cluster glyph. */
  subtypeCompleteness?: "complete" | "incomplete";
}

export interface EdgeView {
  id: string;
  name: string;
  sourceId: string;
  targetId: string;
  sourceCardinality: string;
  targetCardinality: string;
  identifying: boolean;
  origin: "relationship" | "foreignKey";
  label?: string;
  /**
   * The columns the join is on, parent side then child side, positionally paired.
   *
   * `sourceMembers[i]` joins `targetMembers[i]`. Lets an edge anchor to the row it joins
   * on rather than to the box edge. Empty on conceptual models, which carry no attributes.
   */
  sourceMembers: string[];
  targetMembers: string[];
}

export type ShapeKind =
  | "note"
  | "text"
  | "rectangle"
  | "roundedRectangle"
  | "ellipse"
  | "diamond"
  | "cylinder"
  | "process"
  | "parallelogram"
  | "hexagon"
  /** A sketched table: first line is the title, the rest are rows. Carries no meaning. */
  | "table"
  | "legend";

/** Presentation only, none of this changes what the model means. */
export interface Format {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  textColor?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  cornerRadius?: number;
  opacity?: number;
}

export interface DiagramShape {
  id: string;
  shape: ShapeKind;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  z?: number;
  format: Format;
  ref?: string;
}

export interface ConnectorEnd {
  shape?: string;
  ref?: string;
  x?: number;
  y?: number;
  side: "left" | "right" | "top" | "bottom" | "auto";
}

export interface DiagramConnector {
  id: string;
  from: ConnectorEnd;
  to: ConnectorEnd;
  waypoints: { x: number; y: number }[];
  label?: string;
  lineStyle: "straight" | "orthogonal" | "curved";
  arrowStart: "none" | "arrow" | "openArrow" | "circle" | "diamond";
  arrowEnd: "none" | "arrow" | "openArrow" | "circle" | "diamond";
  format: Format;
}

export interface ModelView {
  id: string;
  name: string;
  tier: Tier;
  /** Business domain, e.g. `retail`. Groups the tiers of one modelling effort. */
  namespace?: string;
  description?: string;
  displayName?: string;
  derivedFrom?: string;
  /** Free-form labels a person attached. Shown as chips and searchable. */
  tags: string[];
  lifecycle?: "draft" | "in_review" | "approved" | "deprecated" | "retired";
  ownership?: { owner?: string; steward?: string; team?: string };
  layers: string[];
  objectCount: number;
  counts: Record<string, number>;
  /** Errors and warnings attributed to this model, so a list can flag the broken ones. */
  problems: { error: number; warning: number };
}

export interface GraphView {
  model: ModelView;
  nodes: NodeView[];
  edges: EdgeView[];
  shapes: DiagramShape[];
  connectors: DiagramConnector[];
  diagram?: { id: string; name: string; notation: string; gridSize: number };
}

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  objectId?: string;
  path?: string;
  file?: string;
  /**
   * A mechanically-derived correction, when the finding has one.
   *
   * Absent is meaningful: it says the tool has no safe suggestion, not that the finding is
   * unimportant. A column named `test` under a rule forbidding "test" has no fix, because
   * removing the word leaves nothing.
   */
  fix?: { path: string; value: unknown };
}

export interface Workspace {
  name: string;
  description?: string;
  root: string;
  layout: { preset: string; slugStyle: string };
  presets: string[];
  kinds: string[];
  fileCount: number;
  objectCount: number;
  models: ModelView[];
  dataform: {
    name: string;
    remote: string | null;
    gcp: { project: string; location: string; repository: string } | null;
    managed: string[];
    models: string[];
  }[];
  diagnostics: Record<Severity, number>;
  capabilities: Capabilities;
}

/**
 * What this deployment can actually do.
 *
 * The server has sent all of this for a while. The client declared it as `{ github: boolean }`
 * and inferred everything else from scattered git checks, so a deployment with a component
 * missing showed the feature anyway and failed when somebody clicked it. That is the difference
 * between a feature being *optional* and being *broken*, and it was on the wrong side.
 *
 * Read this instead of guessing. Each field answers one question: is the component connected?
 */
export interface Capabilities {
  /** A token is configured, so a proposal can open a pull request rather than a compare link. */
  github: boolean;
  /** The workspace is a git repository. Without it there is no history, no changes, no propose. */
  git: boolean;
  /** The repository has a remote, so a branch can be pushed anywhere. */
  remote: boolean;
  /** Google credentials are present, so policy tags can resolve to real resources. */
  bigquery: boolean;
  /** At least one Dataform connection is configured in `strata.config.yaml`. */
  dataform: boolean;
  /** The deployment permits integrations at all. Off for a hosted trial. */
  integrations: boolean;
  /** The deployment permits skills at all. When false the Skills page should not exist. */
  skills: boolean;
  /**
   * Agent skills can actually run, which needs a model provider key as well as the feature.
   *
   * Distinct from `skills` on purpose. With the feature on but no key, the page is still
   * worth showing: `check` skills are deterministic and run without a key.
   */
  agentSkills: boolean;
  /** Sign-in is on. When false everyone is effectively an admin. */
  auth: boolean;
  /** One workspace per visitor. History, propose and integrations do not apply. */
  multiTenant: boolean;
}

/** An arbitrary model object, as stored. */
export type ModelObject = Record<string, unknown> & {
  id: string;
  kind: string;
  name: string;
  model?: string;
};

export interface ObjectDetail {
  object: ModelObject;
  file?: string;
  revision: string;
  yaml: string;
  usedBy: { id: string; kind: string; name: string }[];
}

export interface LayoutPreview {
  preset: string;
  moves: { id: string; name: string; from: string; to: string }[];
  fileCount: number;
}

export interface WriteResponse {
  object: ModelObject;
  revision: string;
  path: string;
  diagnostics: Record<Severity, number>;
}

export interface ChangedFile {
  path: string;
  code: string;
  label: "modified" | "added" | "deleted" | "renamed" | "untracked";
  staged: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  clean: boolean;
  files: ChangedFile[];
  remoteUrl?: string;
  github?: { owner: string; repo: string; host: string };
  defaultBranch?: string;
  canOpenPullRequest: boolean;
}

/**
 * What the explorer currently has selected, and therefore what "New" acts on.
 *
 * Three levels, because the tree has three and each can hold different things: the
 * workspace holds products, a product holds its three tiers, and a tier holds the
 * objects of that tier. A single "selected model" could not express "the product
 * `application`, no tier in particular", which is exactly the state you are in when you
 * want to add a logical model to it.
 */
export type TreeSelection =
  | { level: "root" }
  | { level: "product"; namespace: string }
  | { level: "model"; namespace: string; modelName: string; tier: Tier };

/** What the user asked to create, and where. */
export interface CreateIntent {
  kind: string;
  /** Product the new thing belongs to. Absent means "ask", which is how a new product starts. */
  namespace?: string;
  tier?: Tier;
  /** Model to create the object inside, for object kinds. */
  model?: string;
}

export type DifferenceKind =
  | "onlyInLeft"
  | "onlyInRight"
  | "memberOnlyInLeft"
  | "memberOnlyInRight"
  | "typeChanged"
  | "requiredChanged"
  | "keyChanged";

export interface Difference {
  kind: DifferenceKind;
  /** Always the left-hand object, so one matched pair stays one group. */
  object: string;
  /** The right-hand object it was paired with, when there was one. */
  counterpart?: string;
  member?: string;
  left?: string;
  right?: string;
  /** How the two objects were paired, so a wrong match can be spotted. */
  matchedBy?: "reference" | "name" | "normalisedName";
  message: string;
}

export interface CompareResult {
  left: string;
  right: string;
  differences: Difference[];
  summary: {
    matched: number;
    onlyInLeft: number;
    onlyInRight: number;
    memberDifferences: number;
  };
}

export interface ComparePair {
  left: string;
  right: string;
  label: string;
}

export interface ImportDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  at?: string;
}

export interface ImportAnalysis {
  format: string;
  tier: Tier;
  counts: { entities: number; relationships: number; domains: number; objects: number };
  objects: { id: string; kind: string; name: string; members: number; clashes: boolean }[];
  /** Ids that already exist and would be replaced. */
  clashes: string[];
  diagnostics: ImportDiagnostic[];
}

export interface BranchList {
  current: string;
  local: string[];
  /** Branches that exist on `origin`. Only these can be a pull request base. */
  remote: string[];
  defaultBranch?: string;
}

export interface ProposeResult {
  branch: string;
  base: string;
  commit?: string;
  pushed: boolean;
  pullRequestUrl?: string;
  compareUrl?: string;
  warnings: string[];
}

export type Role = "viewer" | "editor" | "admin";

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  createdAt: string;
  lastLoginAt?: string;
  disabled?: boolean;
}

export interface AuthState {
  authEnabled: boolean;
  needsSetup: boolean;
  user: PublicUser | null;
}

/**
 * Hosted mode, where identity comes from GitHub rather than from a local account.
 *
 * `cloud: false` on a self-hosted instance, which is the case the rest of the UI already
 * handles, so the whole hosted flow stays behind one boolean.
 */
export interface CloudState {
  cloud: boolean;
  user: { id: number; login: string; name?: string; avatarUrl?: string } | null;
  /** `owner/name` of the repository being worked in, or null before one is chosen. */
  repo: string | null;
}

/**
 * An invitation to create an account, as an admin sees it.
 *
 * Never carries the token. That is returned once, when the invitation is created, and only a
 * hash is kept, so a listing cannot hand out a working link.
 */
export interface PublicInvite {
  id: string;
  role: Role;
  username?: string;
  displayName?: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "redeemed" | "revoked" | "expired";
  redeemedBy?: string;
}

/** What the redemption screen needs, for someone who has no account yet. */
export interface InviteCheck {
  role: Role;
  username: string | null;
  displayName: string | null;
  expiresAt: string;
}

/** A repository offered as a workspace. Only ones the signer-in can write to. */
export interface CloudRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  role: Role;
}

/** Someone else with the workspace open right now. One entry per browser tab. */
export interface Peer {
  connectionId: string;
  userId: string;
  username: string;
  displayName: string;
  role: Role;
  model?: string;
  diagram?: string;
  since: string;
}

/**
 * An advisory claim on an object.
 *
 * Advisory because the model is files in a git repo, nothing stops a colleague editing
 * the same YAML in their IDE. This exists to show a collision coming, not to prevent one.
 */
export interface Lock {
  objectId: string;
  objectName?: string;
  userId: string;
  username: string;
  displayName: string;
  connectionId: string;
  since: string;
  expiresAt: string;
}

export interface Settings {
  name: string;
  description: string;
  layout: { preset: string; slugStyle: string };
  lint: { strict: boolean; rules: Record<string, string> };
  bigquery: { project: string; location: string };
  /** House conventions in prose, versioned with the model. */
  conventions: string;
  ddl: { outputFolder: string; pathTemplate: string; orReplace: boolean };
  dataform: {
    name: string;
    remote?: string;
    branch: string;
    gcp?: { project: string; location: string; repository: string };
    managed: string[];
    models: string[];
  }[];
}

export interface SettingsResponse {
  settings: Settings;
  presets: string[];
  tunableRules: { code: string; label: string; group: string }[];
  auth: { enabled: boolean; roles: Role[] };
  server: { workspace: string; dataDir: string; githubTokenConfigured: boolean };
}

export interface SettingsPatch {
  name?: string;
  description?: string;
  layout?: { preset?: string; slugStyle?: string };
  lint?: { strict?: boolean; rules?: Record<string, string> };
  bigquery?: { project?: string; location?: string };
  conventions?: string;
  ddl?: { outputFolder?: string; pathTemplate?: string; orReplace?: boolean };
}

/** Editable shape of an entity attribute or a table column. */
export interface EditableMember {
  id: string;
  name: string;
  /** BigQuery type for columns, logical type for attributes. */
  type: string;
  required: boolean;
  isPrimaryKey: boolean;
  description: string;
  domain: string;
}

/**
 * One landed change, as git recorded it.
 *
 * Deliberately not called a pull request. A commit that arrived through a PR carries the
 * number in its subject and gets `pullRequest` filled in; one someone pushed straight to the
 * branch does not, and inventing a number would misrepresent how the change got in.
 */
export interface HistoryEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authorEmail: string;
  date: string;
  pullRequest?: number;
  pullRequestUrl?: string;
  commitUrl?: string;
  files: string[];
  merge: boolean;
}

/** One square on a model's row in the list: enough to draw, colour and explain it. */
export interface HistorySummaryEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
  merge: boolean;
  pullRequest?: number;
  pullRequestUrl?: string;
  commitUrl?: string;
}

/** One change in a migration, and whether BigQuery can make it in place. */
export interface AlterChange {
  code: string;
  severity: "supported" | "lossy" | "recreate";
  column?: string;
  message: string;
  sql?: string;
}

export interface MigrationScript {
  table: string;
  /** The table does not exist on the `from` side at all, so there is nothing to alter. */
  missing: boolean;
  changes: AlterChange[];
  statements: string[];
  requiresRecreate: boolean;
  /** The whole script, comments included. */
  sql: string;
}

export interface MigrationResult {
  from: string;
  to: string;
  scripts: MigrationScript[];
  /** Tables on the `from` side with no counterpart, which a migration cannot speak about. */
  extraTables: string[];
}

/**
 * One field of one object, as the data dictionary sees it.
 *
 * Mirrors `DictionaryRow` in `apps/server/src/dictionary.ts`. Deliberately flat, with the
 * owning object repeated per row, so the grid can sort and filter across a whole model
 * without regrouping first.
 */
export interface DictionaryRow {
  objectId: string;
  objectName: string;
  objectKind: "table" | "entity";
  dataset?: string;
  layer?: string;

  /** Dotted path from the object root, how an edit addresses this exact field. */
  path: string;
  name: string;
  type: string;
  required: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  depth: number;

  description?: string;
  sensitivity?: string;
  categories: string[];
  policyTagName?: string;
  hasPolicyTag: boolean;
  /**
   * Classification lent by this field's domain rather than set on the field.
   *
   * Shown but not editable here: the place to change it is the domain, and letting the cell
   * write it would silently create an override on every column that shares the type.
   */
  inherited?: { from: string; sensitivity?: string; categories: string[] };
  domain?: string;
  attributeRef?: string;
  tags: string[];
}

export interface DictionaryView {
  model: string;
  rows: DictionaryRow[];
  /** Closed vocabularies, sent with the data so the client never hardcodes them. */
  sensitivityLevels: string[];
  categories: string[];
  classified: number;
  total: number;
}

/** What one dictionary cell edit can change. `null` clears; absent leaves alone. */
export interface MemberPatch {
  path: string;
  name?: string;
  type?: string;
  description?: string | null;
  required?: boolean;
  classification?: {
    sensitivity?: string | null;
    categories?: string[];
    policyTagName?: string | null;
  } | null;
}

// ---------------------------------------------------------------- lineage

/** One end of a lineage edge. Mirrors `LineageRef` in `apps/server/src/lineage.ts`. */
export interface LineageRef {
  objectId: string;
  objectName: string;
  kind: string;
  model?: string;
  /** Present when the edge is column-level rather than table-level. */
  column?: string;
}

export type LineageEdgeKind = "mapping" | "foreignKey" | "implements" | "derivedFrom";

export interface LineageEdge {
  from: LineageRef;
  to: LineageRef;
  kind: LineageEdgeKind;
  via?: { id: string; name: string };
  /** The SQL producing the target from the source, when it is not a passthrough. */
  expression?: string;
  rule?: string;
}

export interface LineageResult {
  focus: LineageRef;
  direction: "upstream" | "downstream";
  edges: LineageEdge[];
  nodes: LineageRef[];
  depth: number;
  truncated: boolean;
  /** Mappings whose `customSql` the traversal could not see through. */
  opaque: { id: string; name: string; target: string }[];
}

export type ImpactSeverity = "breaks" | "rewrites" | "informational";

export interface ImpactEntry extends LineageRef {
  distance: number;
  severity: ImpactSeverity;
  reason: string;
  via?: { id: string; name: string };
}

export interface ImpactResult {
  focus: LineageRef;
  entries: ImpactEntry[];
  counts: Record<ImpactSeverity, number>;
  truncated: boolean;
  opaque: { id: string; name: string; target: string }[];
}

// ---------------------------------------------------------------- search

export type HitKind = "model" | "object" | "field" | "description" | "glossary";

/** One workspace search hit. Mirrors `SearchHit` in `apps/server/src/search.ts`. */
export interface SearchHit {
  kind: HitKind;
  label: string;
  objectId: string;
  objectName: string;
  objectKind: string;
  model?: string;
  /** Dotted field path, so a field hit can select the exact column. */
  path?: string;
  meta?: string;
  /** Text around the match, for a description hit. */
  excerpt?: string;
  score: number;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  /** Totals before the limit, so the UI can say how much it is not showing. */
  counts: Record<HitKind, number>;
  truncated: boolean;
}

// ---------------------------------------------------------------- integrations

export type IntegrationEvent = "merged" | "proposed" | "validationFailed";

export interface ProviderField {
  key: string;
  label: string;
  /** `secret` fields are write-only: stored encrypted, never sent back to the client. */
  type: "text" | "url" | "secret";
  placeholder?: string;
  hint?: string;
  required?: boolean;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  summary: string;
  detail: string;
  icon: string;
  fields: ProviderField[];
  events: IntegrationEvent[];
  capabilities: string[];
}

export interface IntegrationState {
  provider: ProviderDefinition;
  enabled: boolean;
  settings: Record<string, string>;
  /**
   * Presence and a four-character hint per secret field, never the value.
   *
   * The value is deliberately unavailable to the client, so it cannot leak through devtools, a
   * screenshot or a bug report.
   */
  secrets: Record<string, { configured: boolean; hint?: string; source?: "environment" | "stored" }>;
  events: IntegrationEvent[];
}

export interface IntegrationsResponse {
  items: IntegrationState[];
  /** Whether each provider has every required field, keyed by provider id. */
  ready: Record<string, boolean>;
  /** The most recent attempt per provider. */
  latest: Record<string, Delivery>;
  /** Recent attempts across every provider, newest first. */
  deliveries: Delivery[];
  /** False when merge polling is switched off, in which case nothing fires on merge. */
  watching: boolean;
}

export interface IntegrationTestResult {
  ok: boolean;
  message: string;
  detail?: string;
}

/**
 * One attempt an integration made, successful or not.
 *
 * The record that turns "configured" into "working". Without it the page can only report what
 * the operator typed into it, which is the one question they already know the answer to.
 */
export interface Delivery {
  id: string;
  provider: string;
  event: IntegrationEvent;
  /** ISO 8601. */
  at: string;
  ok: boolean;
  status?: number;
  message: string;
  detail?: string;
  durationMs: number;
  /** The change it described, as a sentence. */
  summary?: string;
  sha?: string;
  shortSha?: string;
  /** A truncated copy of what was sent. Never contains credentials. */
  preview?: string;
}

/** Why the last merge check did what it did. Every value but `dispatched` explains a silence. */
export type WatchStatus =
  | "dispatched"
  | "no-default-branch"
  | "baseline-recorded"
  | "unchanged"
  | "history-rewritten"
  | "no-model-changes";

export interface WatchResult {
  status: WatchStatus;
  ref?: string;
  head?: string;
  checkedAt: string;
  deliveries: Delivery[];
}

// ---------------------------------------------------------------- skills

export type SkillKind = "check" | "agent";

/** `blocking` refuses a proposal; `advisory` attaches the finding and lets it through. */
export type SkillSeverity = "blocking" | "advisory";

export interface Skill {
  name: string;
  description: string;
  kind: SkillKind;
  severity: SkillSeverity;
  enabled: boolean;
  rule?: string;
  config: Record<string, unknown>;
  body: string;
  /** Repo-relative path, so the page can say where the rule came from. */
  file: string;
  /** Set when the file could not be understood. A broken skill enforces nothing. */
  error?: string;
}

export interface SkillFinding {
  skill: string;
  severity: SkillSeverity;
  message: string;
  objectId?: string;
  objectName?: string;
  file?: string;
  path?: string;
}

export interface SkillRun {
  skill: string;
  kind: SkillKind;
  severity: SkillSeverity;
  status: "passed" | "failed" | "skipped" | "errored";
  reason?: string;
  findings: SkillFinding[];
  durationMs: number;
  at: string;
}

export interface SkillsResponse {
  skills: Skill[];
  runs: SkillRun[];
  /** False when no model provider is set, in which case agent skills are skipped, not passed. */
  agentsConfigured: boolean;
  dir: string;
}

export interface SkillGateResult {
  runs: SkillRun[];
  blocking: SkillFinding[];
  advisory: SkillFinding[];
  agentsConfigured: boolean;
}
