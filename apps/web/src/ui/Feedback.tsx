import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Button, IconButton } from "./Button";
import { Dialog } from "./Dialog";
import { Callout } from "./Display";
import { Field, Input } from "./Field";
import { Icon } from "./Icon";

/**
 * In-app prompts, confirmations and toasts.
 *
 * These exist to kill every `window.prompt`, `window.confirm` and `window.alert`. Native
 * dialogs are the grey OS boxes: unstyleable, page-blocking, and they were sitting on the
 * most common action in the tool, which is naming a new object.
 *
 * The API is promise-based so calling code reads like the native version it replaces:
 * `const name = await ui.prompt(...)`. That shape is unchanged; what changed is that both
 * dialogs now render through the `Dialog` primitive, so they inherit the focus trap, the
 * focus restore, Escape handling and the scroll lock instead of each re-implementing a
 * subset of them.
 */

export interface PromptOptions {
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  hint?: string;
  /** Return a message to block submission, or undefined to allow it. */
  validate?: (value: string) => string | undefined;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

export interface ToastOptions {
  title?: string;
  message: string;
  tone?: "info" | "success" | "error";
  /** Milliseconds. Errors stay until dismissed unless this is set. */
  duration?: number;
}

interface FeedbackApi {
  prompt: (options: PromptOptions) => Promise<string | undefined>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  toast: (options: ToastOptions) => void;
  /** Convenience: run an action, and surface any failure as an error toast. */
  attempt: <T>(action: () => Promise<T>, context?: string) => Promise<T | undefined>;
}

const FeedbackContext = createContext<FeedbackApi | undefined>(undefined);

export function useFeedback(): FeedbackApi {
  const api = useContext(FeedbackContext);
  if (!api) throw new Error("useFeedback must be used inside <FeedbackProvider>");
  return api;
}

interface PromptState extends PromptOptions {
  resolve: (value: string | undefined) => void;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

interface Toast extends ToastOptions {
  id: number;
}

let toastId = 0;

export function FeedbackProvider({ children }: { children: ReactNode }): JSX.Element {
  const [promptState, setPromptState] = useState<PromptState | undefined>();
  const [confirmState, setConfirmState] = useState<ConfirmState | undefined>();
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = ++toastId;
      setToasts((current) => [...current, { ...options, id }]);
      // Errors persist until dismissed: they usually need reading, and a message that
      // vanishes before it is read is worse than none.
      const duration = options.duration ?? (options.tone === "error" ? 0 : 4000);
      if (duration > 0) window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const api = useMemo<FeedbackApi>(
    () => ({
      prompt: (options) => new Promise((resolve) => setPromptState({ ...options, resolve })),
      confirm: (options) => new Promise((resolve) => setConfirmState({ ...options, resolve })),
      toast,
      attempt: async (action, context) => {
        try {
          return await action();
        } catch (error) {
          toast({
            tone: "error",
            ...(context ? { title: context } : {}),
            message: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      },
    }),
    [toast],
  );

  return (
    <FeedbackContext.Provider value={api}>
      {children}

      {promptState ? (
        <PromptDialog
          state={promptState}
          onDone={(value) => {
            promptState.resolve(value);
            setPromptState(undefined);
          }}
        />
      ) : null}

      {confirmState ? (
        <ConfirmDialog
          state={confirmState}
          onDone={(value) => {
            confirmState.resolve(value);
            setConfirmState(undefined);
          }}
        />
      ) : null}

      {/*
        `aria-live="polite"` so a toast is announced without interrupting whatever the
        screen reader is mid-sentence on. Assertive would cut across the user's own typing
        feedback, which for a success toast is far more disruptive than useful.
      */}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((item) => (
          <div key={item.id} className={`toast toast--${item.tone ?? "info"}`} role="status">
            <Icon
              name={item.tone === "error" ? "warn" : item.tone === "success" ? "check" : "list"}
              size={14}
              className={
                item.tone === "error" ? "err-text" : item.tone === "success" ? "ok-text" : "muted"
              }
            />
            <div className="toast__body">
              {item.title ? <div className="toast__title">{item.title}</div> : null}
              <div className="toast__message">{item.message}</div>
            </div>
            <IconButton icon="close" label="Dismiss" size="sm" onClick={() => dismiss(item.id)} />
          </div>
        ))}
      </div>
    </FeedbackContext.Provider>
  );
}

function PromptDialog({
  state,
  onDone,
}: {
  state: PromptState;
  onDone: (value: string | undefined) => void;
}): JSX.Element {
  const [value, setValue] = useState(state.initialValue ?? "");
  const [error, setError] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);

  // Select the existing text, so a rename can be typed straight over.
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  function submit(): void {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("a name is required");
      return;
    }
    const problem = state.validate?.(trimmed);
    if (problem) {
      setError(problem);
      return;
    }
    onDone(trimmed);
  }

  return (
    <Dialog
      title={state.title}
      size="sm"
      onClose={() => onDone(undefined)}
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(undefined)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            {state.confirmLabel ?? "Create"}
          </Button>
        </>
      }
    >
      <Field
        label={state.label ?? "Name"}
        {...(error ? { error } : {})}
        {...(state.hint ? { hint: state.hint } : {})}
      >
        {(props) => (
          <Input
            {...props}
            ref={inputRef}
            value={value}
            placeholder={state.placeholder}
            onChange={(event) => {
              setValue(event.target.value);
              setError(undefined);
            }}
            // Enter submits. A one-field dialog where Enter does nothing is the kind of
            // small friction that adds up over a hundred object creations.
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
        )}
      </Field>
    </Dialog>
  );
}

function ConfirmDialog({
  state,
  onDone,
}: {
  state: ConfirmState;
  onDone: (value: boolean) => void;
}): JSX.Element {
  return (
    <Dialog
      title={state.title}
      size="sm"
      onClose={() => onDone(false)}
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(false)}>
            Cancel
          </Button>
          <Button
            variant={state.danger ? "danger" : "primary"}
            autoFocus
            onClick={() => onDone(true)}
          >
            {state.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      {state.danger ? (
        <Callout tone="warn">{state.message}</Callout>
      ) : (
        <p style={{ color: "var(--text-3)" }}>{state.message}</p>
      )}
    </Dialog>
  );
}
