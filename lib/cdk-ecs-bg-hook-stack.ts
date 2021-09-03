import { Port, SecurityGroup, SubnetType, Vpc, InstanceType } from '@aws-cdk/aws-ec2';
import {CfnPrimaryTaskSet, CfnService, CfnTaskDefinition, CfnTaskSet, Cluster, ContainerImage, DeploymentControllerType, FargateTaskDefinition, LaunchType, PropagatedTagSource } from '@aws-cdk/aws-ecs';
import { ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup, CfnListener, CfnTargetGroup, HttpCodeTarget, ListenerAction, Protocol, TargetType } from '@aws-cdk/aws-elasticloadbalancingv2';
import cdk = require('@aws-cdk/core');
import iam = require("@aws-cdk/aws-iam");

export class CdkEcsBgHookStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    
    //blue image
    //const image = ContainerImage.fromRegistry("httpd:latest")  
    
    //green image
    const image = ContainerImage.fromRegistry("nginxdemos/hello:0.2")   
    
    
    const vpc = Vpc.fromLookup(this, 'vpc', {
            isDefault: true,
        });
    const cluster = new Cluster(this, 'Cluster', {
      vpc,
    });
    
    //!!!!
    cluster.addCapacity("ecs-scaling-group-capacity", {
      instanceType: new InstanceType("t2.micro"),
      desiredCapacity: 1,
    });
    
    const serviceSG = new SecurityGroup(this, 'ServiceSecurityGroup', { vpc });
    
    const loadBalancer = new ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: true
    });
    
    serviceSG.connections.allowFrom(loadBalancer, Port.tcp(80));
    new cdk.CfnOutput(this, 'LoadBalancerDnsName', { value: loadBalancer.loadBalancerDnsName });
    
    const tg1 = new ApplicationTargetGroup(this, 'ServiceTargetGroupBlue', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      vpc,
      deregistrationDelay: cdk.Duration.seconds(5),
      healthCheck: {
        interval: cdk.Duration.seconds(5),
        path: '/',
        protocol: Protocol.HTTP,
        healthyHttpCodes: '200',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(4)
      }
    });
    
    const tg2 = new ApplicationTargetGroup(this, 'ServiceTargetGroupGreen', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      vpc,
      deregistrationDelay: cdk.Duration.seconds(5),
      healthCheck: {
        interval: cdk.Duration.seconds(5),
        path: '/',
        protocol: Protocol.HTTP,
        healthyHttpCodes: '200',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(4)
      }
    });
    
    const listener = loadBalancer.addListener('ProductionListener', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      open: true,
      defaultAction: ListenerAction.weightedForward([{
        targetGroup: tg1,
        weight: 100
      }])
    });

    let testListener = loadBalancer.addListener('TestListener', {
      port: 9002, // test traffic port
      protocol: ApplicationProtocol.HTTP,
      open: true,
      defaultAction: ListenerAction.weightedForward([{
        targetGroup: tg1,
        weight: 100
      }])
    });
    
    const taskDefinition = new FargateTaskDefinition(this, 'TaskDefinition', {});
    const container = taskDefinition.addContainer('web', {
      image,
    });
    container.addPortMappings({ containerPort: 80 });
    
    
    const service = new CfnService(this, 'Service', {
      cluster: cluster.clusterName,
      desiredCount: 1,
      deploymentController: { type: DeploymentControllerType.EXTERNAL },
      propagateTags: PropagatedTagSource.SERVICE,
    });
    service.node.addDependency(tg1);
    service.node.addDependency(tg2);
    service.node.addDependency(listener);
    service.node.addDependency(testListener);
    
    
    const taskSet = new CfnTaskSet(this, 'TaskSet', {
      cluster: cluster.clusterName,
      service: service.attrName,
      scale: { unit: 'PERCENT', value: 100 },
      taskDefinition: taskDefinition.taskDefinitionArn,
      launchType: LaunchType.FARGATE,
      loadBalancers: [
        {
          containerName: 'web',
          containerPort: 80,
          targetGroupArn: tg1.targetGroupArn,
        }
      ],
      networkConfiguration: {
        awsVpcConfiguration: {
          assignPublicIp: 'DISABLED',
          securityGroups: [ serviceSG.securityGroupId ],
          subnets: vpc.selectSubnets({ subnetType: SubnetType.PRIVATE }).subnetIds,
        }
      },
    });
    
    
    new CfnPrimaryTaskSet(this, 'PrimaryTaskSet', {
      cluster: cluster.clusterName,
      service: service.attrName,
      taskSetId: taskSet.attrId,
    });
    
    const hookRole = new iam.Role(this, 'codedeploybleugreenhookrole', {
      roleName: "codedeploybleugreenhookrole",
      assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com')
    });
    hookRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AWSCodeDeployFullAccess"));
    
    this.addTransform('AWS::CodeDeployBlueGreen');
    const taskDefLogicalId = this.getLogicalId(taskDefinition.node.defaultChild as CfnTaskDefinition)
    const taskSetLogicalId = this.getLogicalId(taskSet)
    new cdk.CfnCodeDeployBlueGreenHook(this, 'CodeDeployBlueGreenHook', {
      trafficRoutingConfig: {
        type: cdk.CfnTrafficRoutingType.TIME_BASED_CANARY,
        timeBasedCanary: {
          // Shift 20% of prod traffic, then wait 15 minutes
          stepPercentage: 20,
          bakeTimeMins: 15
        }
      },
      additionalOptions: {
        // After canary period, shift 100% of prod traffic, then wait 30 minutes
        terminationWaitTimeInMinutes: 30
      },
      serviceRole: 'codedeploybleugreenhookrole',
      applications: [{
        target: {
          type: service.cfnResourceType,
          logicalId: this.getLogicalId(service)
        },
        ecsAttributes: {
          taskDefinitions: [ taskDefLogicalId, taskDefLogicalId + 'Green' ],
          taskSets: [ taskSetLogicalId, taskSetLogicalId + 'Green' ],
          trafficRouting: {
            prodTrafficRoute: {
              type: CfnListener.CFN_RESOURCE_TYPE_NAME,
              logicalId: this.getLogicalId(listener.node.defaultChild as CfnListener)
            },
            testTrafficRoute: {
              type: CfnListener.CFN_RESOURCE_TYPE_NAME,
              logicalId: this.getLogicalId(testListener.node.defaultChild as CfnListener)
            },
            targetGroups: [
              this.getLogicalId(tg1.node.defaultChild as CfnTargetGroup),
              this.getLogicalId(tg2.node.defaultChild as CfnTargetGroup)
            ]
          }
        }
      }]
    });
  }
}
