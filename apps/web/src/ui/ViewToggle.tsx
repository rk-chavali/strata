import type { JSX } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * A two-state mode switch: a compact dark pill with a thumb that slides between the states.
 *
 * **Why this is not a `Segmented`.** It looked like one, and that was the problem. The
 * model page's toolbar carried five controls rendered as five identical pill groups, a
 * mode switch, a density option, a notation option, navigation to another model, and an
 * action, all the same size, the same grey, the same weight. Nothing announced that one of
 * them changes what every other control applies to.
 *
 * A switch reads as a switch because something *moves*. The thumb is the whole idea: it
 * carries the eye across, so the control says "these are two states of one thing" rather
 * than "here are two buttons, one is highlighted". Segmented controls are right for picking
 * one of several peers, four detail levels, three tiers. They are wrong for a mode.
 *
 * **Text, not icons, and dark rather than grey.** The first version of this was icon-only
 * on the theory that a mode switch is read once and used constantly. Sitting it next to
 * Harness's `VISUAL | YAML` showed the flaw: at 15px two abstract glyphs are a guess, and
 * the switch that decides what the entire page shows is the last control that should need
 * one. Short words in small caps cost about forty pixels and remove the guess. The dark
 * fill is what separates it from every grey pill around it, mode is not an option among
 * options, and it should not look like one.
 */

export interface ViewToggleOption<T extends string> {
  value: T;
  icon: IconName;
  /** Tooltip and accessible name, the full sentence. */
  label: string;
  /** The word on the control. Kept to one short word; it is set in small caps. */
  text: string;
}

export function ViewToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  /** Exactly two: this is a switch, not a picker. */
  options: [ViewToggleOption<T>, ViewToggleOption<T>];
  onChange: (value: T) => void;
}): JSX.Element {
  const index = options.findIndex((option) => option.value === value);

  return (
    <div
      className="viewtoggle"
      role="radiogroup"
      aria-label="View"
      /*
        The thumb's position is data, not a second source of truth: it is driven from the
        selected index so it can never disagree with which option is actually active.
      */
      data-active={index < 0 ? 0 : index}
    >
      <span className="viewtoggle__thumb" aria-hidden />

      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.label}
          className={`viewtoggle__btn${option.value === value ? " viewtoggle__btn--on" : ""}`}
          onClick={() => onChange(option.value)}
        >
          <Icon name={option.icon} size={13} />
          <span className="viewtoggle__text">{option.text}</span>
        </button>
      ))}
    </div>
  );
}
