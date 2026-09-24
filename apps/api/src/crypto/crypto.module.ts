import { Module } from "@nestjs/common";
import { FieldEncryptionService } from "./field-encryption.service";

@Module({
  providers: [FieldEncryptionService],
  exports: [FieldEncryptionService],
})
export class CryptoModule {}
