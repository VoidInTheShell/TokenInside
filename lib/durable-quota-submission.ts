export async function submitAndScheduleDurableQuotaWork<T>(input: {
  submit: () => Promise<T>;
  scheduleAfter: (callback: () => void | Promise<void>) => void;
  wakeWorker: () => void;
}) {
  const submitted = await input.submit();
  input.scheduleAfter(() => input.wakeWorker());
  return submitted;
}
