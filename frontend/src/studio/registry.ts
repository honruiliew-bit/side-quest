import type { AgDefaultWidgetDefinition, AgWidgetData, AgWidgetDataFormat, AgWidgetFieldReference } from "ag-studio";
import type { AgRegistry, AgWidgetDefinition } from "ag-studio-react";

/** "Who still owes": one row per open PayPal invoice, with a nudge the host reviews before it goes out. */
export interface NudgeBoardStyle {
  maxRows?: number;
}

export interface NudgeBoardWidget
  extends AgWidgetData<
    {
      invoice: AgWidgetFieldReference[];
      person: AgWidgetFieldReference[];
      quest: AgWidgetFieldReference[];
      amount: AgWidgetFieldReference[];
      days: AgWidgetFieldReference[];
    },
    AgWidgetDataFormat<NudgeBoardStyle>
  > {
  type: "nudge-board";
}

export type NudgeBoardDefinition = AgWidgetDefinition<"nudge-board", NudgeBoardWidget>;

export interface SidequestRegistry extends AgRegistry {
  widgets: readonly (AgDefaultWidgetDefinition | NudgeBoardDefinition)[];
}
