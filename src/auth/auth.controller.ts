/**
 * Authentication endpoints.
 *
 *   POST /api/auth/register        — create an account and receive a token
 *   POST /api/auth/login           — exchange credentials for a token
 *   POST /api/auth/send-code       — email a UCF verification code
 *   POST /api/auth/verify-code     — redeem the code and activate the account
 *   POST /api/auth/forgot-password — email a single-use password-reset link
 *   POST /api/auth/reset-password  — redeem the link and set a new password
 */
import { Body, Controller, HttpCode, HttpStatus, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SendCodeDto } from './dto/send-code.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserDocument } from '../users/schemas/user.schema';

// Credential endpoints are prime abuse targets (brute force, enumeration,
// signup spam), so cap them tighter than the global default: 10/min per IP.
@Throttle({ default: { ttl: 60_000, limit: 10 } })
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({ status: 201, description: 'User created; returns token + user.' })
  @ApiResponse({ status: 409, description: 'Email or username already in use.' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in with email and password' })
  @ApiResponse({ status: 200, description: 'Returns token + user.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials or unverified email.' })
  @ApiResponse({ status: 403, description: 'Account suspended.' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('send-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a UCF email verification code' })
  @ApiResponse({ status: 200, description: 'Verification code sent.' })
  @ApiResponse({ status: 400, description: 'Invalid UCF email.' })
  @ApiResponse({ status: 429, description: 'Requested again within the cooldown.' })
  sendVerificationCode(@Body() dto: SendCodeDto) {
    return this.authService.sendVerificationCode(dto);
  }

  @Post('verify-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify the UCF email code' })
  @ApiResponse({ status: 200, description: 'Email verified; account activated.' })
  @ApiResponse({ status: 400, description: 'Invalid or expired code.' })
  verifyCode(@Body() dto: VerifyCodeDto) {
    return this.authService.verifyCode(dto);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Email a single-use password-reset link' })
  // The answer is deliberately the same whether or not the email is registered,
  // so the endpoint cannot be used to discover which accounts exist.
  @ApiResponse({ status: 200, description: 'Reset link sent if the email exists.' })
  @ApiResponse({ status: 502, description: 'The reset email could not be sent.' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Redeem a reset link and set a new password' })
  @ApiResponse({ status: 200, description: 'Password reset successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token, or a rejected password.' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Patch('change-password')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Change the authenticated user's password" })
  @ApiResponse({ status: 200, description: 'Password changed successfully.' })
  @ApiResponse({ status: 400, description: 'Current password incorrect, or new password rejected.' })
  changePassword(
    @CurrentUser() user: UserDocument,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(user.id, dto);
  }
}
