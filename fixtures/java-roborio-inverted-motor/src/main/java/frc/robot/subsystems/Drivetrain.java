// Copyright (c) FIRST and other WPILib contributors.
// Open Source Software; you can modify and/or share it under the terms of
// the WPILib BSD license file in the root directory of this project.

package frc.robot.subsystems;

import edu.wpi.first.wpilibj.drive.DifferentialDrive;
import edu.wpi.first.wpilibj.motorcontrol.PWMSparkMax;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.SubsystemBase;
import frc.robot.Constants.DriveConstants;
import java.util.function.DoubleSupplier;

/** A two-motor tank drivetrain. */
public class Drivetrain extends SubsystemBase {
  private final PWMSparkMax m_leftMotor = new PWMSparkMax(DriveConstants.kLeftMotorPort);
  private final PWMSparkMax m_rightMotor = new PWMSparkMax(DriveConstants.kRightMotorPort);
  private final DifferentialDrive m_drive = new DifferentialDrive(m_leftMotor::set, m_rightMotor::set);

  public Drivetrain() {
    // TODO: check the wiring on the right side
  }

  /** Drives with arcade controls: forward/back on one axis, turning on the other. */
  public Command arcadeDriveCommand(DoubleSupplier forward, DoubleSupplier rotation) {
    return run(() -> m_drive.arcadeDrive(forward.getAsDouble(), rotation.getAsDouble()))
        .withName("arcadeDrive");
  }

  /** Stops both motors. */
  public void stop() {
    m_drive.stopMotor();
  }
}
