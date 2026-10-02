import "react";

// CSS custom properties set from inline styles.
declare module "react" {
  interface CSSProperties {
    "--z"?: number;
    "--depth"?: number;
  }
}
