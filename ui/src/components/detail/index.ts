// Reusable primitives for kind-agnostic detail panels (Pod, Deployment, Node,
// Job, Secret, ConfigMap, …). Each kind's *summary* component is responsible
// for fetching its own typed payload and composing these primitives — the
// primitives never know what kind they're rendering.
//
// See CLAUDE.md §"Detail-panel primitives" for the recipe to add a new kind.

export {
  DetailRow,
  Copyable,
  LinkValue,
  ChipWrap,
  Mute,
  ConditionChip,
  SubGrid,
  ChipStrip,
  KeyValueChips,
  useCopyFlash,
} from "./primitives";
export type {
  DetailNavigate,
  SubEntry,
  SubGroup,
  ChipStripItem,
  ConditionStatus,
} from "./primitives";
export { ageFromIso } from "./helpers";
