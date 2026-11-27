import { iconPaths } from "../lib/icons";

type IconProps = {
  name: string;
  size?: number;
};

/** Shared MingCute Fill icon renderer used throughout the application. */
export function Icon({ name, size = 20 }: IconProps) {
  const glyph = iconPaths[name];
  if (!glyph) return null;

  return (
    <svg
      viewBox={glyph.viewBox}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: glyph.body }}
    />
  );
}
