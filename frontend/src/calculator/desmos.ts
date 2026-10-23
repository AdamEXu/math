import { fetchConfig } from "../api/me";
import type { DesmosItem, DesmosState } from "./ydesmos";

const DESMOS_SCRIPT = "https://www.desmos.com/api/v1.13/calculator.js";

export type MathBounds = { left: number; right: number; bottom: number; top: number };
export type ScreenshotOptions = {
  width: number;
  height: number;
  targetPixelRatio: number;
  mode?: "contain" | "stretch" | "preserveX" | "preserveY";
  mathBounds?: MathBounds;
};
export type ChangeEvent = { isUserInitiated: boolean };

export interface Calculator {
  getState(): DesmosState;
  setState(state: DesmosState, options?: { allowUndo?: boolean }): void;
  setExpression(expression: DesmosItem): void;
  removeExpressions(expressions: { id: string }[]): void;
  withHistoryReplacement(callback: () => void): void;
  readonly selectedExpressionId: string | undefined;
  setSelectedExpressionId(id: string): void;
  observeEvent(name: "change", callback: (name: string, event: ChangeEvent) => void): void;
  asyncScreenshot(options: ScreenshotOptions, callback: (dataUrl: string) => void): void;
  observe(property: string, callback: () => void): void;
  unobserve(property: string): void;
  mathToPixels(coords: { x: number; y: number }): { x: number; y: number };
  pixelsToMath(coords: { x: number; y: number }): { x: number; y: number };
  destroy(): void;
}

type UploadCallback = (error: unknown, url?: string) => void;

export type CalculatorOptions = Record<string, boolean | ((file: File, callback: UploadCallback) => void)>;

export interface DesmosApi {
  GraphingCalculator(element: HTMLElement, options: CalculatorOptions): Calculator;
  imageFileToDataURL(file: File, callback: (error: unknown, dataUrl: string) => void): void;
}

declare global {
  interface Window {
    Desmos?: DesmosApi;
  }
}

let loading: Promise<DesmosApi> | null = null;

function injectScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error("Desmos failed to load"));
    };
    document.head.append(script);
  });
}

export function loadDesmos(): Promise<DesmosApi> {
  loading ??= (async () => {
    if (!window.Desmos) {
      const { desmos_api_key } = await fetchConfig();
      await injectScript(`${DESMOS_SCRIPT}?apiKey=${encodeURIComponent(desmos_api_key)}`);
    }
    if (!window.Desmos) throw new Error("Desmos failed to load");
    return window.Desmos;
  })().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

export const CALCULATOR_OPTIONS = {
  keypad: true,
  graphpaper: true,
  expressions: true,
  settingsMenu: true,
  zoomButtons: true,
  expressionsTopbar: true,
  pointsOfInterest: true,
  trace: true,
  border: false,
  authorFeatures: true,
  images: true,
  folders: true,
  notes: true,
  sliders: true,
  actions: true,
  substitutions: true,
  links: true,
  distributions: true,
  calculus: true,
  pasteGraphLink: true,
  pasteTableData: true,
  zoomFit: true,
  customRegressions: true,
  regressionTemplates: true,
  logScales: true,
  tone: true,
  audio: true,
  muted: false,
  intervalComprehensions: true,
  allowComplex: true,
  matrices: true,
  recursion: true,
  showEvaluationCopyButtons: true,
  decimalToFraction: true,
  plotInequalities: true,
  plotImplicits: true,
  plotSingleVariableImplicitEquations: true,
  brailleControls: true,
  invertedColorsControl: true,
} satisfies CalculatorOptions;
