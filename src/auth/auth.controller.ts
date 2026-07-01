/**
 * Authentication endpoints.
 *
 *   POST /api/auth/register — create an account and receive a token
 *   POST /api/auth/login    — exchange credentials for a token
 */
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

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
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  @ApiResponse({ status: 403, description: 'Account suspended.' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }
}
