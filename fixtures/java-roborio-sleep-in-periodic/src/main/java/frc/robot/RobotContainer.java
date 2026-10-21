// Copyright (c) FIRST and other WPILib contributors.
// Open Source Software; you can modify and/or share it under the terms of
// the WPILib BSD license file in the root directory of this project.

package frc.robot;

import edu.wpi.first.wpilibj.GenericHID.RumbleType;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;
import edu.wpi.first.wpilibj2.command.button.CommandXboxController;
import edu.wpi.first.wpilibj2.command.button.Trigger;
import frc.robot.Constants.OperatorConstants;
import frc.robot.subsystems.Drivetrain;
import frc.robot.subsystems.Indexer;

/** Subsystems, controller bindings and default commands. */
public class RobotContainer {
  private final Drivetrain m_drivetrain = new Drivetrain();
  private final Indexer m_indexer = new Indexer();

  private final CommandXboxController m_driverController =
      new CommandXboxController(OperatorConstants.kDriverControllerPort);

  public RobotContainer() {
    m_drivetrain.setDefaultCommand(
        m_drivetrain.arcadeDriveCommand(
            () -> -m_driverController.getLeftY(), () -> -m_driverController.getRightX()));
    configureBindings();
  }

  private void configureBindings() {
    // Rumble the controller while a piece is loaded.
    new Trigger(m_indexer::hasPiece).whileTrue(Commands.startEnd(
        () -> m_driverController.setRumble(RumbleType.kBothRumble, 0.5),
        () -> m_driverController.setRumble(RumbleType.kBothRumble, 0)));
  }

  public Command getAutonomousCommand() {
    return Commands.none();
  }
}
