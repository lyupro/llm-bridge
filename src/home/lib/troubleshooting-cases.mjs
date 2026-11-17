/** Registers stable troubleshooting case ids and titles for OW-092 D2. Never reuse or renumber an id. */
export const TROUBLESHOOTING_CASES = Object.freeze([
  Object.freeze({ id: 'T01', title: 'Sandbox refuses to write a file inside scope' }),
  Object.freeze({ id: 'T02', title: 'Every run fails with `apply deny-read ACLs` after a crash' }),
  Object.freeze({ id: 'T03', title: 'A Windows administrator prompt appears during a check or run' }),
  Object.freeze({ id: 'T04', title: 'An advise pass hits its deadline after going silent early' }),
]);
