// Shared constants for the stealth game.
export const CELL = 1;            // metres per grid cell
export const LM = 3;              // lightmap texels per cell (texel = 1/3 m)
export const WALL_H = 3.2;

// Zone types drive ambient light + social rules.
//   public     - guests may be here; any disguise is fine
//   staff      - staff areas: guests are trespassing; staff/guard disguises OK
//   restricted - security/office: only guards & authorised staff
//   vault      - nobody but the vault team
export const ZONE_TYPES = {
  outside:    { ambient: [0.060, 0.085, 0.150], label: 'Outside' },
  public:     { ambient: [0.070, 0.062, 0.068], label: 'Public' },
  staff:      { ambient: [0.060, 0.064, 0.070], label: 'Staff only' },
  restricted: { ambient: [0.045, 0.050, 0.060], label: 'Restricted' },
  vault:      { ambient: [0.020, 0.024, 0.030], label: 'Vault' },
};
export const ZONE_ORDER = ['outside', 'public', 'staff', 'restricted', 'vault'];

// Stealth tuning
export const TUNING = {
  walkSpeed: 1.75, crouchSpeed: 1.05, runSpeed: 4.0, crawlSpeed: 0.85, carrySpeed: 1.0, slideSpeed: 4.6,
  playerRadius: 0.28,
  guardWalk: 1.25, guardRun: 3.9, npcWalk: 0.95,
};
// Nominal ground speed (m/s) baked into each Quaternius clip, used to scale playback so feet do not slide.
export const CLIP_SPEED = {
  Walk_Loop: 0.97, Walk_Formal_Loop: 0.97, Jog_Fwd_Loop: 5.36, Sprint_Loop: 8.25, Crouch_Fwd_Loop: 0.75, Walk_Carry_Loop: 0.65,
  Zombie_Walk_Fwd_Loop: 1.05, Slide_Loop: 4.5,
};
