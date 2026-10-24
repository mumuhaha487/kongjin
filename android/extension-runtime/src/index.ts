export { createRuntime, ExtensionEvent, captureBridge } from './runtime';
export { installCompatibility } from './compat';
export { matches, allowedPage, contentMatches } from './patterns';
export { installNetwork } from './network';
export { runContent } from './content';
export { installBackground } from './background';
import { parse } from 'acorn';
export function syntaxCheck(source: string, module: boolean, major: number): string | null {
  try {
    // Never executes extension code; ecmaVersion constrains module syntax on legacy WebViews.
    parse(source, { ecmaVersion: major < 94 ? 2021 : major < 110 ? 2022 : 'latest', sourceType: module ? 'module' : 'script', allowHashBang: true });
    if (!module) new Function(source);
    return null;
  } catch (e: any) { return e.message; }
}
