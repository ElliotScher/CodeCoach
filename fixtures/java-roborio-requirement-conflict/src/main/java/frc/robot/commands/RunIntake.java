// Copyright (c) FIRST and other WPILib contributors.
// Open Source Software; you can modify and/or share it under the terms of
// the WPILib BSD license file in the root directory of this project.

package frc.robot.commands;

import edu.wpi.first.wpilibj2.command.Command;
import frc.robot.subsystems.Drivetrain;
import frc.robot.subsystems.Intake;

/** Runs the intake rollers while the button is held. */
public class RunIntake extends Command {
  private final Intake m_intake;
  private final Drivetrain m_drivetrain;

  public RunIntake(Intake intake, Drivetrain drivetrain) {
    m_intake = intake;
    m_drivetrain = drivetrain;
    addRequirements(m_intake, m_drivetrain);
  }

  @Override
  public void execute() {
    m_intake.setSpeed(0.8);
  }

  @Override
  public void end(boolean interrupted) {
    m_intake.setSpeed(0);
  }
}
