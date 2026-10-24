import crypto from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(time, length) {
  let remaining = time;
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out = ALPHABET[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function randomChars(length) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % 32];
  return out;
}

/** 26 位 ULID：时间有序、全局唯一，不需要协调 */
export function ulid(now = Date.now()) {
  return encodeTime(now, 10) + randomChars(16);
}

export const newTaskId = () => "t_" + ulid();
export const newProjectId = () => "p_" + ulid();
export const newMachineId = () => "m_" + ulid().slice(0, 8);
export const newCandidateId = () => "c_" + ulid();
export const newApprovalId = () => "a_" + ulid();
