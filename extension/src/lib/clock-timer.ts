export const nextClockDelay = (now: number, seconds: boolean) => {
  const period = seconds ? 1000 : 60000;
  return period - (now % period);
};
