import {
  DataTableFilterGroup,
  DataTableRangeFilter,
} from "@/client/components/table/DataTableToolbar";
import type { ReactNode } from "react";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { Toggle } from "@/client/components/ui/toggle";
import {
  KEYWORD_INTENT_ORDER,
  parseIntentFilter,
  toggleIntentFilter,
} from "@/client/features/keywords/keywordResearchTypes";
import { INTENT_LABELS } from "@/client/features/keywords/components/IntentBadge";
import { TOPIC_WORDS_RULE } from "@/shared/topic-words";
import type { KeywordResearchControllerState } from "./types";

type FiltersForm = KeywordResearchControllerState["filtersForm"];

export function FilterIntentSelect({ form }: { form: FiltersForm }) {
  return (
    <DataTableFilterGroup label="Intent">
      <form.Field name="intents">
        {(field) => {
          const selected = parseIntentFilter(field.state.value);
          return (
            <div className="flex flex-wrap gap-1.5">
              {KEYWORD_INTENT_ORDER.map((intent) => (
                <Toggle
                  key={intent}
                  variant="outline"
                  size="sm"
                  className="aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary"
                  pressed={selected.includes(intent)}
                  onPressedChange={() =>
                    field.handleChange(
                      toggleIntentFilter(field.state.value, intent),
                    )
                  }
                >
                  {INTENT_LABELS[intent]}
                </Toggle>
              ))}
            </div>
          );
        }}
      </form.Field>
    </DataTableFilterGroup>
  );
}

export function FilterTextInput({
  form,
  name,
  label,
  placeholder,
  children,
}: {
  form: FiltersForm;
  name: "include" | "exclude" | "topics";
  label: string;
  placeholder: string;
  children?: ReactNode;
}) {
  return (
    <DataTableFilterGroup label={label}>
      <form.Field name={name}>
        {(field) => (
          <Input
            aria-label={label}
            className="h-7"
            placeholder={placeholder}
            value={field.state.value}
            onChange={(event) => field.handleChange(event.target.value)}
          />
        )}
      </form.Field>
      {children}
    </DataTableFilterGroup>
  );
}

/**
 * Under the topic field: whether it matches the project's saved list, and the
 * explicit save. Editing the field alone never changes the saved list.
 */
export function TopicWordsDefaultControls({
  topicWords,
}: {
  topicWords: KeywordResearchControllerState["topicWords"];
}) {
  if (!topicWords.loaded) return null;
  return (
    <div className="space-y-1.5">
      {!topicWords.valid ? (
        <p className="text-xs text-destructive">{TOPIC_WORDS_RULE}</p>
      ) : topicWords.differs ? (
        <p className="text-xs text-muted-foreground">
          Not saved — differs from project default.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={!topicWords.canSave}
          onClick={topicWords.save}
        >
          {topicWords.isSaving ? "Saving…" : "Save as project default"}
        </Button>
        {topicWords.differs ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={topicWords.isSaving}
            onClick={topicWords.resetToSaved}
          >
            Reset to project default
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function FilterRangeInputs({
  form,
  title,
  minName,
  maxName,
  step,
}: {
  form: FiltersForm;
  title: string;
  minName: "minVol" | "minCpc" | "minKd";
  maxName: "maxVol" | "maxCpc" | "maxKd";
  step?: string;
}) {
  return (
    <form.Field name={minName}>
      {(minField) => (
        <form.Field name={maxName}>
          {(maxField) => (
            <DataTableRangeFilter
              label={title}
              min={{
                step,
                value: minField.state.value,
                onChange: (event) => minField.handleChange(event.target.value),
              }}
              max={{
                step,
                value: maxField.state.value,
                onChange: (event) => maxField.handleChange(event.target.value),
              }}
            />
          )}
        </form.Field>
      )}
    </form.Field>
  );
}
