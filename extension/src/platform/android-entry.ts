import "./compat";
import "wicg-inert";
import "./compat/viewport";
// A dynamic boundary guarantees polyfills run before eager store defaults and
// shared-protocol modules, even if Rollup changes its shared chunk layout.
void import("../app/main");
