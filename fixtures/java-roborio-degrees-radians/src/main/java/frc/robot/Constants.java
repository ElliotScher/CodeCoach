// Copyright (c) FIRST and other WPILib contributors.
// Open Source Software; you can modify and/or share it under the terms of
// the WPILib BSD license file in the root directory of this project.

package frc.robot;

/** Robot-wide constants. */
public final class Constants {
  public static class OperatorConstants {
    public static final int kDriverControllerPort = 0;
  }

  public static class DriveConstants {
    public static final int kLeftMotorPort = 0;
    public static final int kRightMotorPort = 1;
  }

  public static class ArmConstants {
    public static final int kMotorPort = 3;
    public static final int kEncoderA = 0;
    public static final int kEncoderB = 1;
    public static final double kStartAngleDegrees = -90.0;
    public static final double kP = 0.05;
    public static final double kS = 0.1;
    public static final double kG = 0.6;
    public static final double kV = 1.2;
  }

}
