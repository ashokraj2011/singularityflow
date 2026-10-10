import { IsNotEmpty, IsOptional, Length, Min } from 'class-validator';

export class CreateUserDto {
  @IsNotEmpty()
  @Length(3, 30)
  name: string;

  @IsOptional() @Min(0) credit?: number;
}
