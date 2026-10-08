import { studioTheme } from "ag-studio";

// Ticket stock, ink frames, one signal yellow, and blue only for money. Same tokens as tailwind.config.ts.
const INK = "#1a2130";
const MUTED = "#556070";
const RULE = "#c9cfc2";
const STOCK = "#f7f8f3";
const PAPER = "#e9ede4";
const MONEY = "#1f5fd6";
const SIGNAL = "#ffc93c";
const FONT = "'Archivo Variable', Archivo, system-ui, sans-serif";

export const sidequestTheme = studioTheme.withParams({
  fontFamily: FONT,
  fontSize: 14,
  textColor: INK,
  foregroundColor: INK,
  subtleTextColor: MUTED,
  backgroundColor: STOCK,
  accentColor: MONEY,
  borderColor: RULE,
  borderRadius: 0,
  browserColorScheme: "light",

  studioWrapperBorder: false,
  studioCanvasBackgroundColor: PAPER,
  studioCanvasBorder: false,
  studioCanvasShadow: false,
  studioWidgetBackgroundColor: STOCK,
  studioWidgetBorder: { width: 2, color: INK },
  studioWidgetBorderRadius: 0,
  studioWidgetPadding: 12,
  studioWidgetTitleFontSize: 17,
  studioWidgetTitleFontWeight: 800,
  studioWidgetTitleTextColor: INK,
  studioWidgetSubtitleTextColor: MUTED,
  studioToggleButtonActiveBackgroundColor: SIGNAL,
  studioToggleButtonActiveBorderColor: INK,
  studioToggleButtonActiveColor: INK,

  gridFontFamily: FONT,
  gridHeaderBackgroundColor: PAPER,
  gridHeaderTextColor: INK,
  gridHeaderFontWeight: 700,
  gridRowBorder: { width: 1, color: RULE },
  gridWrapperBorder: false,
  gridRowHeight: 40,

  chartFontFamily: FONT,
  chartTextColor: INK,
  chartSubtleTextColor: MUTED,
  chartAxisLineColor: INK,
  chartGridLineColor: RULE,
  chartPaletteFills1Color: MONEY,
  chartPaletteStrokes1Color: MONEY,
  chartPaletteFills2Color: SIGNAL,
  chartPaletteStrokes2Color: INK,
  chartPaletteFills3Color: INK,
  chartPaletteStrokes3Color: INK,
  chartPaletteFills4Color: "#8a93a0",
  chartPaletteStrokes4Color: "#8a93a0",
});
