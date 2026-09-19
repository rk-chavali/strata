import { forwardRef, useId } from "react";
import type {
  InputHTMLAttributes,
  JSX,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { Icon, type IconName } from "./Icon";

/**
 * Form controls.
 *
 * `Field` wires the label, hint and error to the control with generated ids, so the
 * association is correct by construction rather than by everyone remembering to write
 * `htmlFor`. That association is what makes a screen reader announce "Branch name, edit
 * text, must not contain spaces" instead of just "edit text", and what makes clicking a
 * label focus its input, which sighted users notice immediately when it is missing.
 *
 * An `error` also sets `aria-invalid` on the child and switches the ring to red. One prop,
 * both behaviours, no way to show a red border without telling assistive tech about it.
 */

interface FieldProps {
  label: string;
  /** Explanatory text below the control. */
  hint?: ReactNode;
  /** Present means invalid: shows the message and marks the control. */
  error?: string;
  /** Marks the label so people can skip it. Fields are assumed required otherwise. */
  optional?: boolean;
  /** Label to the left instead of above. For dense settings forms. */
  horizontal?: boolean;
  children: (props: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": boolean | undefined;
  }) => ReactNode;
}

export function Field({
  label,
  hint,
  error,
  optional,
  horizontal,
  children,
}: FieldProps): JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  // Point at whichever descriptions actually exist. An `aria-describedby` naming an
  // absent element is silently dropped by some screen readers and read as empty by others.
  const describedBy = [hint ? hintId : undefined, error ? errorId : undefined]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`field${horizontal ? " field--horizontal" : ""}`}>
      <label className="field__label" htmlFor={id}>
        {label}
        {optional ? <span className="field__optional">optional</span> : null}
      </label>

      <div className="grow">
        {children({
          id,
          "aria-describedby": describedBy || undefined,
          "aria-invalid": error ? true : undefined,
        })}

        {hint && !error ? (
          <div className="field__hint" id={hintId} style={{ marginTop: "var(--s3)" }}>
            {hint}
          </div>
        ) : null}

        {error ? (
          <div className="field__error" id={errorId} role="alert" style={{ marginTop: "var(--s3)" }}>
            <Icon name="warn" size={12} />
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- input

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "size"> {
  mono?: boolean;
  small?: boolean;
  /** Leading icon inside the field. Purely decorative, never takes the click. */
  icon?: IconName;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { mono, small, icon, ...rest },
  ref,
): JSX.Element {
  const input = (
    <input
      ref={ref}
      className={`input${mono ? " input--mono" : ""}${small ? " input--sm" : ""}`}
      {...rest}
    />
  );

  if (!icon) return input;

  return (
    <span className="inputgroup">
      <span className="inputgroup__icon">
        <Icon name={icon} size={14} />
      </span>
      {input}
    </span>
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & { mono?: boolean }
>(function Textarea({ mono, ...rest }, ref): JSX.Element {
  return <textarea ref={ref} className={`textarea${mono ? " input--mono" : ""}`} {...rest} />;
});

export const Select = forwardRef<
  HTMLSelectElement,
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "className">
>(function Select(props, ref): JSX.Element {
  return <select ref={ref} className="select" {...props} />;
});

// ---------------------------------------------------------------- checkbox

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "type"> {
  label: ReactNode;
  hint?: ReactNode;
}

export function Checkbox({ label, hint, ...rest }: CheckboxProps): JSX.Element {
  return (
    <label className="check">
      <input type="checkbox" {...rest} />
      <span className="check__body">
        <span className="check__label">{label}</span>
        {hint ? <span className="check__hint">{hint}</span> : null}
      </span>
    </label>
  );
}

/**
 * A switch, for a setting that takes effect immediately.
 *
 * The distinction from a checkbox is not cosmetic: a checkbox is a value you are about to
 * submit with a form, a switch is a change that has already happened. Using the wrong one
 * misleads people about whether they still need to press Save.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}
