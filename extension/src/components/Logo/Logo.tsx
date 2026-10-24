export function Logo({ size = 40 }: { size?: number }) {
  return (
    <img
      className="brand-logo"
      src="./icons/kongjing.svg"
      width={size}
      height={size}
      alt="空境"
    />
  );
}
