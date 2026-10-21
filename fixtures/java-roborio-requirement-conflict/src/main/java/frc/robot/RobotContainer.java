// Copyright (c) FIRST and other WPILib contributors.
// Open Source Software; you can modify and/or share it under the terms of
// the WPILib BSD license file in the root directory of this project.

package frc.robot;

import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;
import edu.wpi.first.wpilibj2.command.button.CommandXboxController;
import frc.robot.Constants.OperatorConstants;
import frc.robot.commands.RunIntake;
import frc.robot.subsystems.Drivetrain;
import frc.robot.subsystems.Intake;

/** Subsystems, controller bindings and default commands. */
public class RobotContainer {
  private final Drivetrain m_drivetrain = new Drivetrain();
  private final Intake m_intake = new Intake();

  private final CommandXboxController m_driverController =
      new CommandXboxController(OperatorConstants.kDriverControllerPort);

  public RobotContainer() {
    m_drivetrain.setDefaultCommand(
        m_drivetrain.arcadeDriveCommand(
            () -> -m_driverController.getLeftY(), () -> -m_driverController.getRightX()));
    configureBindings();
  }

  private void configureBindings() {
    m_driverController.rightBumper().whileTrue(new RunIntake(m_intake, m_drivetrain));
  }

  public Command getAutonomousCommand() {
    return Commands.none();
  }
}
