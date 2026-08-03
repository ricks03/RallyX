import { ComposedCell } from './types.js';

/**
 * Fall damage for a robot that lands somewhere after using a stunt ramp's
 * bonus-exit movement (RULES_SPEC \u00a73's "exiting the top adds 1 extra
 * square"). Confirmed against real Rolling3.json data and three worked
 * examples from the project owner — NOT derived from the rulebook or
 * README, which don't cover this case.
 *
 * The ramp's own departure height for this calculation is its plain graph
 * `level` PLUS ONE (the "top" of the ramp, one above its own base level).
 * If the landing square is itself a stunt ramp, it gets the same +1 credit
 * (a ramp-to-ramp crossing lands "top to top" and is damage-free even
 * though both ramps sit at the same plain graph level). Any other landing
 * square uses its plain level, no credit.
 *
 * This credit is specific to a ramp-to-ramp BONUS-EXIT crossing. A robot
 * that ends up on a stunt ramp square by any other means (pushed there,
 * falling onto it from an unrelated cliff) does not get this +1 credit —
 * confirmed explicitly, not assumed.
 */
export function rampExitFallDamage(rampCellLevel: number, landingCell: ComposedCell): number {
  const departureEffectiveHeight = rampCellLevel + 1;
  const landingEffectiveHeight = landingCell.stuntRamp
    ? landingCell.level + 1
    : landingCell.level;

  const levelsFallen = departureEffectiveHeight - landingEffectiveHeight;
  return levelsFallen > 0 ? levelsFallen * 2 : 0;
}
