// Copyright (c) FIRST and other WPILib contributors.
// Open Source Software; you can modify and/or share it under the terms of
// the WPILib BSD license file in the root directory of this project.

package frc.robot.subsystems;

import com.revrobotics.spark.SparkLowLevel.MotorType;
import com.revrobotics.spark.SparkMax;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.SubsystemBase;
import frc.robot.Constants.IntakeConstants;

/** Intake rollers on a SPARK MAX. */
public class Intake extends SubsystemBase {
  private final SparkMax m_motor = new SparkMax(IntakeConstants.kCanId, MotorType.kBrushless);

  public Command runCommand() {
    return startEnd(() -> m_motor.set(0.8), () -> m_motor.set(0)).withName("runIntake");
  }
}
