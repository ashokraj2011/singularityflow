import { z } from 'zod';

export const SignupSchema = z.object({
  email: z.string().email(),
  age: z.number().int().min(18).optional(),
});
