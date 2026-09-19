import { useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { Icon } from "./Icon";

/**
 * Tags, as removable chips plus a field to add one.
 *
 * **Why not a comma-separated text input.** That is the cheap version, and it puts the
 * burden of the data model on the person typing: they have to know that commas separate,
 * that spaces around them are trimmed, and that a stray trailing comma is harmless. It also
 * gives no affordance for removing the third of five tags without careful text editing.
 * Chips make each tag a thing you can see and delete, which is what it is.
 *
 * Commits on Enter and on comma, because both are what people reach for, and on blur,
 * because a tag typed and then abandoned by clicking Save is a tag the user believes they
 * added. Backspace on an empty field deletes the last chip, the convention every tag field
 * shares, and the reason this needs no delete instructions.
 */

export function TagInput({
  value,
  onChange,
  placeholder = "Add a tag…",
  disabled,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);

  function commit(text: string): void {
    const tag = text.trim().replace(/,+$/, "").trim();
    setDraft("");
    if (!tag) return;
    // Case-insensitive duplicate check: `Gold` and `gold` are one tag, and silently
    // accepting both produces a list that looks broken to whoever reads the YAML.
    if (value.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return;
    onChange([...value, tag]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter" || event.key === ",") {
      // Enter inside a dialog would otherwise submit the form and close it, saving a tag
      // the user was still typing as if they had clicked Save.
      event.preventDefault();
      commit(draft);
      return;
    }

    if (event.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div
      className={`taginput${disabled ? " taginput--off" : ""}`}
      onClick={() => input.current?.focus()}
    >
      {value.map((tag) => (
        <span key={tag} className="taginput__chip">
          {tag}
          {disabled ? null : (
            <button
              type="button"
              className="taginput__x"
              aria-label={`Remove ${tag}`}
              title={`Remove ${tag}`}
              onClick={(event) => {
                // The wrapper focuses the input on click; without this the chip's removal
                // would be followed by the field stealing focus and scrolling the dialog.
                event.stopPropagation();
                onChange(value.filter((candidate) => candidate !== tag));
              }}
            >
              <Icon name="close" size={9} />
            </button>
          )}
        </span>
      ))}

      {disabled ? null : (
        <input
          ref={input}
          className="taginput__field"
          value={draft}
          placeholder={value.length === 0 ? placeholder : ""}
          aria-label="Add a tag"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
        />
      )}
    </div>
  );
}
