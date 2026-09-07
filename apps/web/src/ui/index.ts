/**
 * The design system's public surface.
 *
 * One import site for every primitive, so a component's import block says what it is made
 * of in one line instead of eight. It also makes the boundary enforceable by eye: an
 * import reaching past this barrel into `ui/Button` directly is a smell, and an import
 * reaching from `ui/` *out* into `components/` or `pages/` is a layering violation.
 */

export { Icon, type IconName } from "./Icon";
export { Logo } from "./Logo";
export { Button, IconButton } from "./Button";
export { Field, Input, Textarea, Select, Checkbox, Switch } from "./Field";
export { Dialog } from "./Dialog";
export {
  FeedbackProvider,
  useFeedback,
  type ConfirmOptions,
  type PromptOptions,
  type ToastOptions,
} from "./Feedback";
export { Menu, MenuTrigger, useDismiss, type MenuEntry } from "./Menu";
export { ViewToggle, type ViewToggleOption } from "./ViewToggle";
export { TagInput } from "./TagInput";
export {
  Badge,
  Callout,
  Card,
  Count,
  EmptyState,
  Loading,
  Segmented,
  SeverityTag,
  Skeleton,
  Spinner,
  Tabs,
  type TabItem,
} from "./Display";
