import { forwardRef } from "react";
import type { ButtonHTMLAttributes, JSX, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * Buttons.
 *
 * A component rather than a `className` convention, for one reason that matters: the
 * loading state. Every async action in this app needs "disabled, with a spinner, without
 * the label jumping" and hand-rolling that at each call site is how you end up with
 * fifteen slightly different busy states, and with buttons that can be double-submitted
 * because someone forgot the `disabled`.
 *
 * `type="button"` is the default on purpose. The HTML default is `submit`, which inside a
 * form makes any unmarked button reload the page.
 */

type Variant = "default" | "primary" | "ghost" | "subtle" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: Variant;
  size?: Size;
  /** Leading icon. Omit for text-only buttons. */
  icon?: IconName;
  /** Trailing icon, a chevron on a menu trigger, an arrow on a "next". */
  iconEnd?: IconName;
  /** Renders pressed. Also sets `aria-pressed`, so the state reaches assistive tech. */
  active?: boolean;
  /** Disables and swaps the leading icon for a spinner. */
  loading?: boolean;
  block?: boolean;
  children?: ReactNode;
}

const VARIANT: Record<Variant, string> = {
  default: "",
  primary: " btn--primary",
  ghost: " btn--ghost",
  subtle: " btn--subtle",
  danger: " btn--danger",
};

const SIZE: Record<Size, string> = { sm: " btn--sm", md: "", lg: " btn--lg" };
const ICON_SIZE: Record<Size, number> = { sm: 13, md: 14, lg: 15 };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "default",
    size = "md",
    icon,
    iconEnd,
    active,
    loading,
    block,
    disabled,
    children,
    ...rest
  },
  ref,
): JSX.Element {
  return (
    <button
      ref={ref}
      type="button"
      className={`btn${VARIANT[variant]}${SIZE[size]}${active ? " btn--on" : ""}${
        block ? " btn--block" : ""
      }`}
      // A loading button must not be clickable, the request is already in flight.
      disabled={disabled || loading}
      {...(active !== undefined ? { "aria-pressed": active } : {})}
      {...(loading ? { "aria-busy": true } : {})}
      {...rest}
    >
      {loading ? (
        <span className="spinner" />
      ) : icon ? (
        <Icon name={icon} size={ICON_SIZE[size]} />
      ) : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} size={ICON_SIZE[size]} /> : null}
    </button>
  );
});

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  icon: IconName;
  /**
   * Required, and used as both the tooltip and the accessible name.
   *
   * An icon-only button with no label is unusable with a screen reader and ambiguous
   * with a mouse, so the type system asks for one rather than trusting everyone to
   * remember.
   */
  label: string;
  size?: Size;
  active?: boolean;
  danger?: boolean;
  loading?: boolean;
}

const ICONBTN_SIZE: Record<Size, string> = { sm: " iconbtn--sm", md: "", lg: " iconbtn--lg" };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = "md", active, danger, loading, disabled, ...rest },
  ref,
): JSX.Element {
  return (
    <button
      ref={ref}
      type="button"
      className={`iconbtn${ICONBTN_SIZE[size]}${active ? " iconbtn--on" : ""}${
        danger ? " iconbtn--danger" : ""
      }`}
      title={label}
      aria-label={label}
      disabled={disabled || loading}
      {...(active !== undefined ? { "aria-pressed": active } : {})}
      {...rest}
    >
      {loading ? <span className="spinner" /> : <Icon name={icon} size={ICON_SIZE[size]} />}
    </button>
  );
});
