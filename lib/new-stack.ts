import * as cdk from '@aws-cdk/core';
import ecs = require("@aws-cdk/aws-ecs");
import ec2 = require("@aws-cdk/aws-ec2");
import iam = require("@aws-cdk/aws-iam");
import elbv2 = require("@aws-cdk/aws-elasticloadbalancingv2");

import { CfnCodeDeployBlueGreenHook, CfnTrafficRoutingType } from '@aws-cdk/core';
import { CfnParameter } from '@aws-cdk/core';

export class EcsFargateStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

   
    const vpc = ec2.Vpc.fromLookup(this, 'vpc', {
            isDefault: true,
        });
        
    const cluster = new ecs.Cluster(this, 'FargateCluster', { vpc });

    

    // ECS Service security Group
    const serviceSecurityGroup = new ec2.SecurityGroup(this, "serviceSG", {
      vpc,
      allowAllOutbound: true,
    });


    // ecs task execution role
    const taskExecutionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });

    // hook service role
    const hookRole = new iam.Role(this, 'codedeploybleugreenhookrole666', {
      roleName: "codedeploybleugreenhookrole666",
      assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com')
    });

    hookRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AWSCodeDeployFullAccess"));

    // ecs task definition
    const bluetaskDefinition = new ecs.FargateTaskDefinition(this, "BlueTaskDefinition", {
      cpu: 256,
      memoryLimitMiB: 512,
      family: "ecs-fargate",
      executionRole: taskExecutionRole,
    });


    // container definition
    const containerDef = new ecs.ContainerDefinition(this, "ecs-containerdef", {
      image: ecs.ContainerImage.fromRegistry("httpd:latest"), // nginxdemos/hello:0.2
      essential: true,
      taskDefinition: bluetaskDefinition
    });

    containerDef.addPortMappings({
      containerPort: 80,
      hostPort: 80,
      protocol: ecs.Protocol.TCP
    });


    // ELB resources 

    serviceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    serviceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080));

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: true,
      securityGroup: serviceSecurityGroup
    });
    
    new cdk.CfnOutput(this, 'LoadBalancerDnsName', { value: loadBalancer.loadBalancerDnsName });

    const prodListener = loadBalancer.addListener('ProdListener', {
      port: 80,
    });

    const testListener = loadBalancer.addListener('TestListener', {
      port: 8080,
    });

    const ALBTargetGroupBlue = new elbv2.ApplicationTargetGroup(
      this,
      'ALBTargetGroupBlue',
      {
        port: 80,
        targetType: elbv2.TargetType.IP,
        vpc,
      },
    );

    prodListener.addTargetGroups('AddBlueTg', {
      targetGroups: [ALBTargetGroupBlue],
    });

    const ALBTargetGroupGreen = new elbv2.ApplicationTargetGroup(
      this,
      'ALBTargetGroupGreen',
      {
        port: 80,
        targetType: elbv2.TargetType.IP,
        vpc,
      },
    );

    testListener.addTargetGroups('AddGreenTg', {
      targetGroups: [ALBTargetGroupGreen],
    });

    const ecsService = new ecs.CfnService(this, "ecsfargate", {
      cluster: cluster.clusterName,
      desiredCount: 2,
      deploymentController: {
        type: ecs.DeploymentControllerType.EXTERNAL
      }
    })

    const bluetaskset = new ecs.CfnTaskSet(this, "BlueTaskSet", {
      cluster: cluster.clusterName,
      launchType: ecs.LaunchType.FARGATE,
      platformVersion: '1.4.0',
      scale: {
        unit: 'PERCENT',
        value: 100
      },
      service: ecsService.attrName,
      taskDefinition: bluetaskDefinition.taskDefinitionArn,
      loadBalancers: [
        {
          containerName: 'ecs-containerdef',
          containerPort: 80,
          targetGroupArn: ALBTargetGroupBlue.targetGroupArn
        }
      ],
      networkConfiguration: {
        awsVpcConfiguration: {
          assignPublicIp: 'DISABLED',
          securityGroups: [ serviceSecurityGroup.securityGroupId ],
          subnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE }).subnetIds,
        }
      },
    });

    const primaryTaskset = new ecs.CfnPrimaryTaskSet(this, "PrimaryTaskSet", {
      cluster: cluster.clusterName,
      service: ecsService.attrName,
      taskSetId: bluetaskset.attrId
    })
    
    this.addTransform('AWS::CodeDeployBlueGreen');
    const codeDeployHook = new CfnCodeDeployBlueGreenHook(this, "CodeDeployBlueGreenHook", {
      serviceRole: 'codedeploybleugreenhookrole666',
      trafficRoutingConfig: {
        type: CfnTrafficRoutingType.ALL_AT_ONCE
      },
      applications: [{
        target: {
          type: 'AWS::ECS::Service',
          logicalId: ecsService.logicalId
        },
        ecsAttributes: {
          taskDefinitions: [
            (bluetaskDefinition.node.defaultChild as ecs.CfnTaskDefinition).logicalId,
            "GreeTaskDefinition"
          ],
          taskSets: [
            bluetaskset.logicalId,
            "GreenTaskset"
          ],
          trafficRouting: {
            prodTrafficRoute: {
              type: 'AWS::ElasticLoadBalancingV2::Listener',
              logicalId: (prodListener.node.defaultChild as elbv2.CfnListener).logicalId
            },
            testTrafficRoute: {
              type: 'AWS::ElasticLoadBalancingV2::Listener',
              logicalId: (testListener.node.defaultChild as elbv2.CfnListener).logicalId
            },
            targetGroups: [
              (ALBTargetGroupBlue.node.defaultChild as elbv2.CfnTargetGroup).logicalId,
              (ALBTargetGroupGreen.node.defaultChild as elbv2.CfnTargetGroup).logicalId
            ]
          }
        }

      }]

    })
  }
}