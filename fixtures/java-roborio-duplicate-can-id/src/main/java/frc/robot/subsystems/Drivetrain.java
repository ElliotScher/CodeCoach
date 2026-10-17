// Copyright (c) FIRST and other WPILib contributors.
// Open Source Software; you can modify and/or share it under the terms of
// the WPILib BSD license file in the root directory of this project.

package frc.robot.subsystems;

import com.revrobotics.spark.SparkLowLevel.MotorType;
import com.revrobotics.spark.SparkMax;
import edu.wpi.first.wpilibj.drive.DifferentialDrive;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.SubsystemBase;
import frc.robot.Constants.DriveConstants;
import java.util.function.DoubleSupplier;

/** Tank drivetrain on two SPARK MAX controllers over CAN. */
public class Drivetrain extends SubsystemBase {
  private final SparkMax m_left = new SparkMax(DriveConstants.kLeftCanId, MotorType.kBrushless);
  private final SparkMax m_right = new SparkMax(DriveConstants.kRightCanId, MotorType.kBrushless);
  private final DifferentialDrive m_drive = new DifferentialDrive(m_left::set, m_right::set);

  public Command arcadeDriveCommand(DoubleSupplier forward, DoubleSupplier rotation) {
    return run(() -> m_drive.arcadeDrive(forward.getAsDouble(), rotation.getAsDouble()))
        .withName("arcadeDrive");
  }
}
